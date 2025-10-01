import os
import shutil
import tempfile
import json
import struct
import pandas as pd
import numpy as np
import mne
from uuid import UUID
from pathlib import Path
from mne_bids import BIDSPath, write_raw_bids
import zstandard as zstd

from src.db import get_db_connection, get_db_cursor
# ### <<< 修正点 >>> ###
# MinIOバケット名とクライアントをインポートします。
from src.minio_utils import minio_client, RAW_DATA_BUCKET, MEDIA_BUCKET, BIDS_BUCKET
from src.task_manager import update_task_status

# --- デバイス/ファームウェア仕様からの定数 ---
SAMPLE_RATE = 256
NUM_EEG_CHANNELS = 8
CH_NAMES = ["Fp1", "Fp2", "F7", "F8", "T7", "T8", "P7", "P8"]
CH_TYPES = ["eeg"] * NUM_EEG_CHANNELS
HEADER_SIZE = 18
POINT_SIZE = 53

def parse_eeg_data_from_binary(data: bytes) -> np.ndarray:
    """
    展開されたチャンクから生のバイナリデータを解析し、EEGサンプルのNumPy配列に変換します。
    """
    num_points = (len(data) - HEADER_SIZE) // POINT_SIZE
    if num_points <= 0:
        return np.empty((NUM_EEG_CHANNELS, 0))

    eeg_samples = []
    for i in range(num_points):
        offset = HEADER_SIZE + (i * POINT_SIZE)
        eeg_point = struct.unpack_from('<' + 'H' * NUM_EEG_CHANNELS, data, offset)
        eeg_samples.append(eeg_point)

    eeg_array = np.array(eeg_samples, dtype=np.float64).T
    data_in_volts = (eeg_array - 2048.0) * (4.5 / 4096.0)
    return data_in_volts

def create_bids_dataset(
    experiment_id: UUID,
    task_id: UUID,
    output_dir: str | Path,
    zip_output: bool = True
) -> str:
    """
    BIDSエクスポートプロセスを調整するメイン関数。
    zip化の有無と出力先を指定できるように変更。

    :param experiment_id: 対象の実験ID
    :param task_id: 管理用のタスクID
    :param output_dir: BIDSデータセットの出力先ディレクトリ
    :param zip_output: Trueの場合、結果をZIP圧縮する
    :return: BIDSデータセットのパスまたはZIPファイルのパス
    """
    bids_root = Path(output_dir) / "bids_dataset"
    os.makedirs(bids_root, exist_ok=True)
    print(f"[Task: {task_id}] Starting export for experiment {experiment_id}. Output dir: {bids_root}")

    try:
        update_task_status(task_id, progress=5, status_message="Fetching metadata")
        with get_db_connection() as conn:
            with get_db_cursor(conn) as cur:
                # --- 1. 実験とセッションのメタデータを取得 ---
                cur.execute("SELECT name, description FROM experiments WHERE experiment_id = %s", (str(experiment_id),))
                exp = cur.fetchone()
                if not exp:
                    raise ValueError(f"Experiment {experiment_id} not found.")

                cur.execute(
                    "SELECT * FROM sessions WHERE experiment_id = %s AND event_correction_status = 'completed' ORDER BY start_time",
                    (str(experiment_id),)
                )
                sessions = cur.fetchall()
                if not sessions:
                    raise ValueError(f"No fully processed sessions found for experiment {experiment_id}.")

                # --- 2. トップレベルのBIDSファイルを作成 ---
                dataset_description = {
                    "Name": exp['name'], "BIDSVersion": "1.8.0", "DatasetType": "raw",
                    "Authors": ["EEG Platform User"]
                }
                with open(bids_root / 'dataset_description.json', 'w') as f:
                    json.dump(dataset_description, f, indent=2)

                participant_ids = sorted(list(set([s['user_id'].replace('-', '') for s in sessions])))
                participants_df = pd.DataFrame({'participant_id': participant_ids})
                participants_df.to_csv(bids_root / 'participants.tsv', sep='\t', index=False)
                
                # --- 3. 刺激（Stimuli）をダウンロード ---
                update_task_status(task_id, progress=15, status_message="Downloading stimuli")
                stimuli_dir = bids_root / 'stimuli'
                os.makedirs(stimuli_dir, exist_ok=True)
                
                cur.execute("SELECT file_name, object_id FROM experiment_stimuli WHERE experiment_id = %s", (str(experiment_id),))
                stimuli = cur.fetchall()
                for stim in stimuli:
                    stim_path = stimuli_dir / stim['file_name']
                    minio_client.fget_object(MEDIA_BUCKET, stim['object_id'], str(stim_path))
                
                if stimuli:
                    stimuli_df = pd.DataFrame({'stim_file': [f"stimuli/{s['file_name']}" for s in stimuli]})
                    stimuli_df.to_csv(bids_root / 'stimuli.tsv', sep='\t', index=False)

                # --- 4. 各セッションを処理 ---
                dctx = zstd.ZstdDecompressor()
                for i, session in enumerate(sessions):
                    progress = 20 + int(70 * (i / len(sessions)))
                    update_task_status(task_id, progress=progress, status_message=f"Processing session {i+1}/{len(sessions)}")

                    subject_id = session['user_id'].replace('-', '')
                    
                    raw_task_name = session.get('session_type', exp['name'])
                    if not raw_task_name or not raw_task_name.strip():
                        task_name = "defaulttask"
                    else:
                        task_name = raw_task_name.replace('_', '').replace('-', '').replace(' ', '')

                    bids_path = BIDSPath(subject=subject_id, session=str(i+1), task=task_name, root=bids_root, datatype='eeg')

                    cur.execute(
                        """
                        SELECT rdo.object_id, rdo.start_time_device
                        FROM raw_data_objects rdo JOIN session_object_links sol ON rdo.object_id = sol.object_id
                        WHERE sol.session_id = %s ORDER BY rdo.start_time_device ASC
                        """,
                        (session['session_id'],)
                    )
                    data_objects = cur.fetchall()
                    if not data_objects:
                        print(f"Warning: No raw data found for session {session['session_id']}. Skipping.")
                        continue
                    
                    all_eeg_data = []
                    for obj in data_objects:
                        response = minio_client.get_object(RAW_DATA_BUCKET, obj['object_id'])
                        compressed_data = response.read()
                        decompressed_data = dctx.decompress(compressed_data)
                        eeg_data = parse_eeg_data_from_binary(decompressed_data)
                        if eeg_data.size > 0:
                            all_eeg_data.append(eeg_data)

                    if not all_eeg_data:
                        print(f"Warning: Could not parse EEG data for session {session['session_id']}. Skipping.")
                        continue
                    full_eeg_data = np.concatenate(all_eeg_data, axis=1)

                    mne_info = mne.create_info(ch_names=CH_NAMES, sfreq=SAMPLE_RATE, ch_types=CH_TYPES)
                    mne_info.set_montage("standard_1020", on_missing='warn')
                    raw = mne.io.RawArray(full_eeg_data, mne_info, verbose=False)
                    
                    cur.execute(
                        """
                        SELECT se.onset, se.duration, se.trial_type, se.onset_corrected_us, COALESCE(es.file_name, ci.file_name) as file_name
                        FROM session_events se
                        LEFT JOIN experiment_stimuli es ON se.stimulus_id = es.stimulus_id
                        LEFT JOIN calibration_items ci ON se.calibration_item_id = ci.item_id
                        WHERE se.session_id = %s AND se.onset_corrected_us IS NOT NULL
                        ORDER BY se.onset_corrected_us ASC
                        """,
                        (session['session_id'],)
                    )
                    events = cur.fetchall()

                    write_raw_bids(raw, bids_path, overwrite=True, verbose=False, allow_preload=True, format='EDF')
                    
                    if events:
                        t0_us = data_objects[0]['start_time_device']
                        events_data = {
                            'onset': [(e['onset_corrected_us'] - t0_us) / 1_000_000.0 for e in events],
                            'duration': [e['duration'] for e in events],
                            'trial_type': [e['trial_type'] for e in events],
                            'stim_file': [f"stimuli/{e['file_name']}" if e['file_name'] else "n/a" for e in events]
                        }
                        events_df = pd.DataFrame(events_data)
                        events_df.to_csv(bids_path.copy().update(suffix='events', extension='.tsv'), sep='\t', index=False)

                    sidecar_path = bids_path.copy().update(suffix='eeg', extension='.json').fpath
                    with open(sidecar_path, 'r', encoding='utf-8') as f:
                        sidecar_data = json.load(f)

                    sidecar_data['PowerLineFrequency'] = 50
                    sidecar_data['EEGReference'] = "n/a"

                    with open(sidecar_path, 'w', encoding='utf-8') as f:
                        json.dump(sidecar_data, f, indent=4)

                    channels_path = bids_path.copy().update(suffix='channels', extension='.tsv').fpath
                    channels_df = pd.read_csv(channels_path, sep='\t')
                    channels_df['status'] = 'good'
                    channels_df.to_csv(channels_path, sep='\t', index=False, na_rep='n/a')

        if zip_output:
            update_task_status(task_id, progress=90, status_message="Compressing dataset")
            zip_base_name = Path(output_dir) / f"eid_{experiment_id}"
            zip_path = shutil.make_archive(
                base_name=str(zip_base_name),
                format='zip',
                root_dir=output_dir,
                base_dir='bids_dataset'
            )
            
            # ### <<< 修正点 >>> ###
            # 完成したZIPファイルをMinIOにアップロードします。
            object_name = os.path.basename(zip_path)
            minio_client.fput_object(
                bucket_name=BIDS_BUCKET,
                object_name=object_name,
                file_path=zip_path,
            )
            print(f"[Task: {task_id}] Uploaded BIDS archive to MinIO: {object_name}")

            # 処理が正常に完了したことをデータベースに報告します。
            update_task_status(task_id, progress=100, status='completed', result_path=object_name)
            return zip_path
        else:
            # こちらの分岐でも正常完了を報告します。
            update_task_status(task_id, progress=100, status='completed', result_path=str(bids_root.resolve()))
            return str(bids_root.resolve())

    except Exception as e:
        print(f"❌ BIDS export failed for task {task_id}: {e}")
        import traceback
        traceback.print_exc()
        update_task_status(task_id, status='failed', error_message=str(e))
        # 再スローして呼び出し元でエラーを検知できるようにする
        raise

