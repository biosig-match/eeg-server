import logging
from pathlib import Path
import pandas as pd
import mne
from mne_bids import BIDSPath, read_raw_bids

# --- ロガー設定 ---
logger = logging.getLogger(__name__)

def create_epochs_from_bids(
    bids_root_path: Path,
    sessions_df: pd.DataFrame,
    task: str,
    tmin: float = -0.2,
    tmax: float = 0.8,
    baseline: tuple | None = (-0.2, 0),
) -> mne.Epochs | None:
    """
    BIDSデータセットからMNEのEpochsオブジェクトを生成・結合する。

    :param bids_root_path: BIDSデータセットのルートディレクトリのパス
    :param sessions_df: 対象となるセッション情報を含むDataFrame ('session_id', 'user_id')
    :param task: BIDSのtaskエンティティ (例: 'calibration', 'main')
    :param tmin: Epochの開始時間 (秒)
    :param tmax: Epochの終了時間 (秒)
    :param baseline: ベースライン補正の期間 (秒)
    :return: 結合されたMNE Epochsオブジェクト。対象データがない場合はNone。
    """
    all_epochs = []
    
    # ユーザーごと、セッションごとに処理
    for user_id in sessions_df['user_id'].unique():
        subject_id = user_id.replace('-', '')
        user_sessions = sessions_df[sessions_df['user_id'] == user_id]

        for i, row in enumerate(user_sessions.itertuples()):
            session_id = str(i + 1) # BIDSではセッションは通常 '1', '2'... と連番になる

            try:
                bids_path = BIDSPath(
                    subject=subject_id,
                    session=session_id,
                    task=task,
                    datatype='eeg',
                    root=bids_root_path
                )
                
                logger.info(f"Reading BIDS data from: {bids_path.directory}")
                raw = read_raw_bids(bids_path=bids_path, verbose=False)
                
                # イベント情報を読み込む
                events_path = bids_path.copy().update(suffix='events', extension='.tsv')
                if not events_path.fpath.exists():
                    logger.warning(f"No events file found for {bids_path}. Skipping this session.")
                    continue
                
                events_df = pd.read_csv(events_path.fpath, sep='\t')
                
                # MNEが要求するイベント配列形式 (サンプル番号, 0, イベントID) に変換
                events = []
                event_id_map = {}
                
                # trial_typeをイベントIDにマッピングする
                unique_trial_types = events_df['trial_type'].unique()
                for idx, trial_type in enumerate(unique_trial_types, 1):
                    event_id_map[trial_type] = idx

                for _, event_row in events_df.iterrows():
                    onset_sample = int(event_row['onset'] * raw.info['sfreq'])
                    event_id = event_id_map[event_row['trial_type']]
                    events.append([onset_sample, 0, event_id])
                
                if not events:
                    logger.warning(f"No events could be parsed for {bids_path}. Skipping.")
                    continue

                # Epochsを作成
                epochs = mne.Epochs(
                    raw,
                    events=events,
                    event_id=event_id_map,
                    tmin=tmin,
                    tmax=tmax,
                    baseline=baseline,
                    preload=True, # データをメモリにロード
                    verbose=False
                )
                all_epochs.append(epochs)
                logger.info(f"Successfully created {len(epochs)} epochs for sub-{subject_id}, ses-{session_id}")

            except FileNotFoundError:
                logger.warning(f"BIDS data not found for subject '{subject_id}', session '{session_id}', task '{task}'. Skipping.")
                continue
            except Exception as e:
                logger.error(f"Error processing BIDS data for sub-{subject_id}, ses-{session_id}: {e}")
                import traceback
                traceback.print_exc()
                continue

    if not all_epochs:
        logger.warning(f"No epochs were created for task '{task}'.")
        return None

    # すべてのEpochsを結合して返す
    logger.info(f"Concatenating a total of {len(all_epochs)} Epochs objects.")
    return mne.concatenate_epochs(all_epochs, verbose=False)

