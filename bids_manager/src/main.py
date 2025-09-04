import os
import uuid
import pandas as pd
import numpy as np
import mne
import json
from mne_bids import BIDSPath, write_raw_bids
from flask import Flask, request, jsonify, send_from_directory
from datetime import timezone, datetime
import psycopg2
import psycopg2.extras
from concurrent.futures import ThreadPoolExecutor

app = Flask(__name__)
DATABASE_URL = os.getenv('DATABASE_URL', 'postgres://admin:password@db:5432/erp_data')
BIDS_OUTPUT_DIR = '/app/bids_output'
executor = ThreadPoolExecutor(max_workers=2)
export_tasks = {}

def get_db_connection():
    return psycopg2.connect(DATABASE_URL)

def run_bids_export_task(task_id, experiment_id):
    """バックグラウンドでBIDSエクスポート処理を実行する関数"""
    try:
        export_tasks[task_id] = {"status": "running", "progress": 0, "message": "データベースに接続しています..."}
        db_conn = get_db_connection()
        with db_conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            cur.execute("SELECT * FROM experiments WHERE experiment_id = %s", (experiment_id,))
            exp_info = cur.fetchone()
            if not exp_info: raise ValueError("指定された実験IDが見つかりません。")

            export_tasks[task_id]["progress"] = 10
            export_tasks[task_id]["message"] = "脳波データを取得しています..."
            cur.execute("SELECT timestamp, eeg_values FROM eeg_raw_data WHERE experiment_id = %s ORDER BY timestamp ASC", (experiment_id,))
            eeg_rows = cur.fetchall()
            if not eeg_rows: raise ValueError("指定された期間の脳波データが見つかりません。")

            export_tasks[task_id]["progress"] = 40
            export_tasks[task_id]["message"] = "MNE-BIDS形式に変換しています..."

            eeg_data = np.array([row['eeg_values'] for row in eeg_rows])
            sample_rate = exp_info['metadata']['sampling_rate']
            data_in_microvolts = (eeg_data.astype(np.float64) - 2048.0) * (exp_info['metadata'].get('adc_gain', 200.0) / 2048.0)
            data_in_volts = data_in_microvolts.T * 1e-6
            
            info = mne.create_info(ch_names=exp_info['metadata']['channel_names'], sfreq=sample_rate, ch_types='eeg')
            info.set_montage('standard_1020', on_missing='warn')
            
            first_samp_datetime = eeg_rows[0]['timestamp']
            raw = mne.io.RawArray(data_in_volts, info)
            raw.set_meas_date(first_samp_datetime)

            cur.execute("SELECT * FROM experiment_events WHERE experiment_id = %s ORDER BY onset ASC", (experiment_id,))
            event_rows = cur.fetchall()
            if event_rows:
                annotations = mne.Annotations(
                    onset=[row['onset'] for row in event_rows],
                    duration=[row['duration'] for row in event_rows],
                    description=[row['description'] for row in event_rows]
                )
                raw.set_annotations(annotations)
            
            task_name_raw = exp_info['metadata'].get('task_name', 'erp')
            task_name_sanitized = task_name_raw.replace('_', '').replace('-', '').replace('/', '')

            bids_path = BIDSPath(
                subject=exp_info['participant_id'], 
                session=exp_info['start_time'].strftime('%Y%m%d'), 
                task=task_name_sanitized, 
                root=BIDS_OUTPUT_DIR
            )
            
            write_raw_bids(
                raw, 
                bids_path, 
                allow_preload=True, 
                format='EDF', 
                overwrite=True, 
                verbose=False
            )
        
        db_conn.close()
        export_tasks[task_id] = {"status": "completed", "progress": 100, "message": f"エクスポートが完了しました。ファイルは {bids_path.basename} として保存されました。"}
    except Exception as e:
        print(f"BIDSエクスポートタスク(ID: {task_id})でエラー: {e}")
        export_tasks[task_id] = {"status": "failed", "message": str(e)}

@app.route("/api/v1/experiments", methods=["POST"])
def create_experiment():
    """新しい実験セッションを開始"""
    data = request.get_json()
    if not all(k in data for k in ['participant_id', 'device_id', 'metadata']):
        return jsonify({"error": "participant_id, device_id, metadataは必須です。"}), 400
    exp_id = str(uuid.uuid4())
    db_conn = get_db_connection()
    with db_conn.cursor() as cur:
        cur.execute("INSERT INTO experiments (experiment_id, participant_id, device_id, start_time, metadata) VALUES (%s, %s, %s, %s, %s)",
            (exp_id, data['participant_id'], data['device_id'], datetime.now(timezone.utc), json.dumps(data['metadata'])))
        db_conn.commit()
    return jsonify({"status": "created", "experiment_id": exp_id}), 201

@app.route("/api/v1/experiments/<experiment_id>/events", methods=["POST"])
def upload_events(experiment_id):
    """
    イベントCSVを登録し、DB内のトリガ信号と照合してonsetを計算し、実験を終了します。
    """
    if 'file' not in request.files: 
        return jsonify({"error": "イベントのCSVファイルが見つかりません。"}), 400
    
    file = request.files['file']
    try:
        events_df = pd.read_csv(file)
        if not all(col in events_df.columns for col in ['t_or_nt', 'image']):
            return jsonify({"error": "CSVには 't_or_nt' と 'image' の列が必要です。"}), 400
    except Exception as e:
        return jsonify({"error": f"CSVファイルの読み込みに失敗しました: {e}"}), 400
        
    db_conn = get_db_connection()
    with db_conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        # 1. 実験情報と、記録された最初のEEGサンプルのタイムスタンプを取得
        cur.execute("SELECT start_time FROM experiments WHERE experiment_id = %s", (experiment_id,))
        exp_info = cur.fetchone()
        if not exp_info: return jsonify({"error": "指定された実験IDが見つかりません。"}), 404
        
        cur.execute("SELECT MIN(timestamp) as first_sample_time FROM eeg_raw_data WHERE experiment_id = %s", (experiment_id,))
        timing_info = cur.fetchone()
        if not timing_info or not timing_info['first_sample_time']:
             return jsonify({"error": "この実験に対応する脳波データが見つかりません。"}), 404
        
        first_sample_time = timing_info['first_sample_time']
        
        # 2. この実験で記録された全てのトリガ信号のタイムスタンプを取得
        cur.execute(
            "SELECT timestamp FROM eeg_raw_data WHERE experiment_id = %s AND trigger_value = 1 ORDER BY timestamp ASC",
            (experiment_id,)
        )
        trigger_timestamps = [row['timestamp'] for row in cur.fetchall()]

        # 3. CSVのイベント数とDBのトリガ数が一致するか検証
        if len(events_df) != len(trigger_timestamps):
            msg = f"イベント数とトリガ数が一致しません。 (CSVイベント: {len(events_df)}, DBトリガ: {len(trigger_timestamps)})"
            return jsonify({"error": msg}), 400

        # 4. 各イベントのonsetを計算し、DBに保存するレコードを作成
        event_records = []
        for index, row in events_df.iterrows():
            trigger_time = trigger_timestamps[index]
            
            # Onsetは「記録開始からの経過秒数」
            onset_seconds = (trigger_time - first_sample_time).total_seconds()
            
            event_type = "target" if row['t_or_nt'] == 1 else "nontarget"
            description = f"{event_type}/{row['image']}"
            duration = 1.0  # 仮のduration
            
            event_records.append((experiment_id, onset_seconds, duration, description, row['image']))

        # 5. 計算したイベント情報をDBに一括登録
        if event_records:
            psycopg2.extras.execute_values(cur, "INSERT INTO experiment_events (experiment_id, onset, duration, description, stimulus_file) VALUES %s", event_records)
        
        # 6. 実験を終了状態にする
        cur.execute("UPDATE experiments SET end_time = %s WHERE experiment_id = %s", (datetime.now(timezone.utc), experiment_id))
        db_conn.commit()
        
    return jsonify({"status": "events registered and experiment finished", "events_matched": len(event_records)}), 200

@app.route("/api/v1/experiments/<experiment_id>/export", methods=["POST"])
def start_export(experiment_id):
    task_id = str(uuid.uuid4())
    export_tasks[task_id] = {"status": "pending"}
    executor.submit(run_bids_export_task, task_id, experiment_id)
    return jsonify({"status": "accepted", "task_id": task_id}), 202

@app.route("/api/v1/export-tasks/<task_id>", methods=["GET"])
def get_export_status(task_id):
    task = export_tasks.get(task_id)
    if not task: return jsonify({"error": "タスクIDが見つかりません"}), 404
    return jsonify(task)

@app.route("/api/v1/downloads/<path:filepath>", methods=["GET"])
def download_file(filepath):
    return send_from_directory(BIDS_OUTPUT_DIR, filepath, as_attachment=True)

if __name__ == '__main__':
    if not os.path.exists(BIDS_OUTPUT_DIR): os.makedirs(BIDS_OUTPUT_DIR)
    app.run(host='0.0.0.0', port=5001)