import base64
import io
import json
import os
import random
import struct
import threading
import time
from datetime import datetime

import requests
import websocket
import zstandard

# Allow enabling/disabling verbose WS trace via env
websocket.enableTrace(os.getenv("WS_TRACE", "0") == "1")

# --- 設定 ---
API_BASE_URL = os.getenv("API_BASE_URL", "http://localhost:8080/api/v1")
WS_URL = os.getenv("WS_URL", "ws://localhost:8080/api/v1/eeg")

ESP32_DEVICE_ID = os.getenv("ESP32_DEVICE_ID", "esp32-dev-01")
PARTICIPANT_ID = os.getenv("PARTICIPANT_ID", "sub01")
SAMPLE_RATE = int(os.getenv("SAMPLE_RATE", "256"))
SAMPLES_PER_PACKET = int(os.getenv("SAMPLES_PER_PACKET", "128"))
ESP32_SENSOR_FORMAT = "<" + "H" * 8 + "f" * 3 + "f" * 3 + "B" + "b" * 8 + "I"

# ★★★ 実験シミュレーション用の設定を追加 ★★★
EXPERIMENT_DURATION_SEC = int(os.getenv("EXPERIMENT_DURATION_SEC", "20"))  # 実験全体の時間（秒）
STIMULUS_INTERVAL_SEC = float(os.getenv("STIMULUS_INTERVAL_SEC", "2.0"))  # 刺激を提示する間隔（秒）
SEND_REALTIME = os.getenv("SEND_REALTIME", "1") == "1"  # 1: 実時間、0: 可能な限り高速

# --- グローバル変数 ---
ws_connection_ready = threading.Event()
stop_sending_eeg = threading.Event()
triggers_sent_count = 0
trigger_lock = threading.Lock()


# ★★★ トリガ信号を生成できるように関数を改良 ★★★
def generate_esp32_packet(start_micros, trigger_now=False):
    """
    1パケット分のセンサーデータを生成します。
    trigger_nowがTrueの場合、最初のサンプルのトリガ値を1にします。
    """
    raw_bytes = b""
    for i in range(SAMPLES_PER_PACKET):
        eeg = [int(2048 + 200 * random.uniform(-1, 1)) for _ in range(8)]
        accel = [random.uniform(-2, 2) for _ in range(3)]
        gyro = [random.uniform(-250, 250) for _ in range(3)]

        # 最初のサンプルにのみトリガを立てる
        trigger = 1 if i == 0 and trigger_now else 0

        impedance = [random.randint(5, 15) for _ in range(8)]
        timestamp = start_micros + int(i * (1_000_000 / SAMPLE_RATE))
        raw_bytes += struct.pack(
            ESP32_SENSOR_FORMAT, *eeg, *accel, *gyro, trigger, *impedance, timestamp
        )
    return raw_bytes


# ★★★ トリガ信号を一定間隔で送信するロジックに改良 ★★★
def send_eeg_data(ws, experiment_start_time):
    """EEGデータを送信し続けるスレッド。実験時間中はトリガも送信する。"""
    global triggers_sent_count
    print("EEG送信スreadを開始します...")

    last_stimulus_time = time.time()

    while not stop_sending_eeg.is_set():
        current_esp_micros = int((time.time() - experiment_start_time) * 1_000_000)

        trigger_this_packet = False
        # 実験開始後、かつ次の刺激提示時間になったらトリガを立てる
        if (
            time.time() > experiment_start_time
            and (time.time() - last_stimulus_time) >= STIMULUS_INTERVAL_SEC
        ):
            trigger_this_packet = True
            last_stimulus_time = time.time()
            with trigger_lock:
                triggers_sent_count += 1
            print(f"  -> 💥 トリガ #{triggers_sent_count} を送信")

        raw_data = generate_esp32_packet(current_esp_micros, trigger_now=trigger_this_packet)
        compressed_data = zstandard.ZstdCompressor().compress(raw_data)

        message = {
            "device_id": ESP32_DEVICE_ID,
            "server_received_timestamp": datetime.now().isoformat(),
            "payload": base64.b64encode(compressed_data).decode("utf-8"),
        }
        try:
            ws.send(json.dumps(message))
        except Exception as e:
            print(f"EEG送信中にエラーが発生しました: {e}")
            break

        if SEND_REALTIME:
            time.sleep(SAMPLES_PER_PACKET / SAMPLE_RATE)

    print("EEG送信スレッドを停止しました。")


def on_open(ws):
    print("✅ WebSocket接続が確立しました。")
    ws_connection_ready.set()


def on_error(ws, error):
    print(f"❌ WebSocketエラーが発生しました: {error}")


def on_close(ws, close_status_code, close_msg):
    print("🚪 WebSocket接続が閉じられました。")


# ★★★ 実験ワークフローを更新 ★★★
def run_experiment_workflow():
    """実験の全フローをシミュレートするメイン関数"""
    print("--- 実験ワークフローを開始します ---")

    print("\n[ステップ1] 新しい実験を開始します...")
    exp_metadata = {
        "task_name": "simulatederp",
        "sampling_rate": SAMPLE_RATE,
        "channel_names": ["Fp1", "Fp2", "F7", "F8", "T7", "T8", "P7", "P8"],
    }
    response = requests.post(
        f"{API_BASE_URL}/experiments",
        json={
            "participant_id": PARTICIPANT_ID,
            "device_id": ESP32_DEVICE_ID,
            "metadata": exp_metadata,
        },
    )
    if response.status_code != 201:
        print(f"実験の開始に失敗しました: {response.text}")
        return
    experiment_id = response.json()["experiment_id"]
    print(f"実験が正常に開始されました。 experiment_id: {experiment_id}")

    print(f"\n[ステップ2] {EXPERIMENT_DURATION_SEC}秒間の実験・データ記録を開始します...")
    time.sleep(EXPERIMENT_DURATION_SEC)

    print(
        f"\n[ステップ3] 送信したトリガ数 ({triggers_sent_count}回) に合わせてイベントCSVを生成し、実験を終了します..."
    )

    # 送信したトリガの数だけイベントリストを作成
    csv_header = "t_or_nt,image\n"
    csv_rows = []
    for i in range(triggers_sent_count):
        is_target = 1 if random.random() < 0.2 else 0  # 20%の確率でターゲット
        image_name = f"target_{i}.jpg" if is_target == 1 else f"nontarget_{i}.jpg"
        csv_rows.append(f"{is_target},{image_name}\n")

    event_csv_content = csv_header + "".join(csv_rows)
    print("--- 生成されたCSV ---")
    print(event_csv_content.strip())
    print("--------------------")

    files = {"file": ("events.csv", io.StringIO(event_csv_content), "text/csv")}
    response = requests.post(f"{API_BASE_URL}/experiments/{experiment_id}/events", files=files)
    if response.status_code != 200:
        print(f"イベントのアップロードに失敗しました: {response.text}")
        return
    print("イベントが正常に登録され、実験が終了しました。")

    # EEG送信スレッドに停止を通知
    stop_sending_eeg.set()

    print("\n[ステップ4] BIDSエクスポートを要求します...")
    response = requests.post(f"{API_BASE_URL}/experiments/{experiment_id}/export")
    if response.status_code != 202:
        print(f"BIDSエクスポートの要求に失敗しました: {response.text}")
        return
    task_id = response.json()["task_id"]
    print(f"エクスポートタスクが受理されました。 task_id: {task_id}")

    print("\n[ステップ5] エクスポートタスクの完了をポーリングします...")
    for _ in range(10):
        time.sleep(3)
        response = requests.get(f"{API_BASE_URL}/export-tasks/{task_id}")
        status = response.json()
        print(f"  タスク状況: {status.get('status')} - {status.get('message')}")
        if status.get("status") in ["completed", "failed"]:
            break

    print("\n--- 実験ワークフローが完了しました ---")


if __name__ == "__main__":
    ws = websocket.WebSocketApp(WS_URL, on_open=on_open, on_error=on_error, on_close=on_close)
    ws_thread = threading.Thread(target=ws.run_forever)
    ws_thread.daemon = True
    ws_thread.start()

    print("WebSocketサーバーへの接続を待っています...")
    if not ws_connection_ready.wait(timeout=5):
        print("❌ WebSocketサーバーへの接続がタイムアウトしました。Nginxの設定を確認してください。")
        ws.close()
        exit(1)

    experiment_start_time = time.time()
    eeg_sender = threading.Thread(target=send_eeg_data, args=(ws, experiment_start_time))
    eeg_sender.daemon = True
    eeg_sender.start()

    run_experiment_workflow()

    ws.close()
    print("すべての処理が完了しました。")
