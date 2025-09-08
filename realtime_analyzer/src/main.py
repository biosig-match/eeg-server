import base64
import io
import json
import os
import struct
import threading
import time

import matplotlib
import mne
import numpy as np
import pika
from flask import Flask, jsonify
from mne_connectivity import spectral_connectivity_epochs

# MatplotlibがGUIのないサーバー環境で動作するための設定
matplotlib.use("Agg")
from datetime import datetime

import matplotlib.pyplot as plt

# --- Flaskアプリケーションとグローバル変数 ---
app = Flask(__name__)
# 解析結果はここに格納され、API経由でアプリに提供される
latest_analysis_results = {}
analysis_lock = threading.Lock()  # latest_analysis_resultsへのスレッドセーフなアクセスを保証

# RabbitMQから受信した生データを一時的に保持するバッファ
data_buffer = np.array([])
buffer_lock = threading.Lock()  # data_bufferへのスレッドセーフなアクセスを保証

# --- 定数と設定 (環境変数から取得) ---
RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@rabbitmq:5672")
SAMPLE_RATE = int(os.getenv("SAMPLE_RATE", "256"))
NUM_EEG_CHANNELS = 8
ANALYSIS_WINDOW_SEC = 2.0  # 2秒間のデータで解析
ANALYSIS_WINDOW_SAMPLES = int(SAMPLE_RATE * ANALYSIS_WINDOW_SEC)
CHANNEL_NAMES = ["Fp1", "Fp2", "F7", "F8", "T7", "T8", "P7", "P8"]

# ESP32ファームウェアで定義されたデータ構造に対応するunpackフォーマット
# < はリトルエンディアン
# H: uint16 (EEG x8)
# f: float (加速度x3, ジャイロx3)
# B: uint8 (トリガ)
# b: int8 (インピーダンス x8)
# I: uint32 (タイムスタンプ)
ESP32_SENSOR_FORMAT = (
    "<" + "H" * NUM_EEG_CHANNELS + "f" * 3 + "f" * 3 + "B" + "b" * NUM_EEG_CHANNELS + "I"
)
ESP32_SENSOR_SIZE = struct.calcsize(ESP32_SENSOR_FORMAT)

# MNEライブラリ用の情報オブジェクトを事前に作成
mne_info = mne.create_info(ch_names=CHANNEL_NAMES, sfreq=SAMPLE_RATE, ch_types="eeg")
try:
    # 10-20法に基づいた標準的な電極位置を設定
    mne_info.set_montage("standard_1020", on_missing="warn")
except Exception as e:
    print(
        f"警告: 電極位置(Montage)の設定に失敗しました。空間的な色のプロットが機能しない可能性があります。エラー: {e}"
    )


# --- ヘルパー関数 ---
def fig_to_base64(fig):
    """MatplotlibのFigureオブジェクトをBase64エンコードされたPNG文字列に変換します。"""
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight", pad_inches=0.1)
    # メモリリークを防ぐため、Figureオブジェクトを明示的に閉じる
    plt.close(fig)
    buf.seek(0)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


# --- バックグラウンド処理スレッド ---


def analysis_worker():
    """
    バックグラウンドで定期的に実行され、バッファ内のデータから脳波解析を行います。
    このスレッドはCPU負荷の高い計算を担当します。
    """
    global latest_analysis_results, data_buffer
    print("解析ワーカースレッドが待機中です...")
    while True:
        # 次の解析まで10秒待機
        time.sleep(10)

        with buffer_lock:
            if data_buffer.shape[0] < ANALYSIS_WINDOW_SAMPLES:
                # 解析に必要なサンプル数がバッファに溜まっていなければスキップ
                continue
            # バッファの末尾から解析に必要な分だけデータをコピー
            data_chunk = data_buffer[-ANALYSIS_WINDOW_SAMPLES:, :]

        try:
            # 1. データの前処理: ADC値を国際単位系のボルト(V)に変換
            # (ADC値 - オフセット) * (電圧範囲 / ADC分解能) * 単位変換(uV -> V)
            data_in_volts = (data_chunk.T.astype(np.float64) - 2048.0) * (4.5 / 4096.0) * 1e-6
            raw = mne.io.RawArray(data_in_volts, mne_info, verbose=False)

            # 2. パワースペクトル密度 (PSD) の計算とプロット
            fig_psd = raw.compute_psd(fmin=1, fmax=45, n_fft=SAMPLE_RATE, verbose=False).plot(
                show=False, spatial_colors=True
            )
            psd_b64 = fig_to_base64(fig_psd)

            # 3. α帯 (8-13Hz) のコヒーレンス (同期度) の計算とプロット
            epochs = mne.make_fixed_length_epochs(
                raw, duration=ANALYSIS_WINDOW_SEC, preload=True, verbose=False
            )
            con = spectral_connectivity_epochs(
                epochs,
                method="coh",
                sfreq=SAMPLE_RATE,
                fmin=8,
                fmax=13,
                faverage=True,
                verbose=False,
            )
            con_matrix = con.get_data(output="dense")[0]
            fig_coh, _ = mne.viz.plot_connectivity_circle(
                con_matrix, CHANNEL_NAMES, show=False, vmin=0, vmax=1
            )
            coh_b64 = fig_to_base64(fig_coh)

            # 4. スレッドセーフに解析結果を更新
            with analysis_lock:
                latest_analysis_results = {
                    "psd_image": psd_b64,
                    "coherence_image": coh_b64,
                    "timestamp": datetime.now().isoformat(),
                }
            print(
                f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] リアルタイム解析結果を更新しました。"
            )
        except Exception as e:
            print(f"解析ワーカースレッドでエラーが発生しました: {e}")


def rabbitmq_consumer():
    """
    RabbitMQからEEGデータを受信し、解析用のグローバルバッファに追加します。
    このスレッドはネットワークI/Oを専門に担当します。
    """
    global data_buffer
    while True:
        try:
            connection = pika.BlockingConnection(pika.URLParameters(RABBITMQ_URL))
            channel = connection.channel()
            # Processorが出力するトピックエクスチェンジを宣言
            channel.exchange_declare(exchange="processed_data_exchange", exchange_type="topic")

            # このサービス専用の一時的なキューを作成
            result = channel.queue_declare(queue="", exclusive=True)
            queue_name = result.method.queue
            # 'eeg.processed' ルーティングキーを持つメッセージのみを購読
            channel.queue_bind(
                exchange="processed_data_exchange", queue=queue_name, routing_key="eeg.processed"
            )

            def callback(ch, method, properties, body):
                global data_buffer
                try:
                    message = json.loads(body)
                    # メッセージからEEGデータ(Numpy配列)を復元
                    eeg_list = message["eeg_data"]
                    new_samples = np.array(eeg_list, dtype=np.int16)

                    with buffer_lock:
                        if data_buffer.size == 0:
                            data_buffer = new_samples
                        else:
                            # 既存バッファに新しいサンプルを追加
                            data_buffer = np.vstack([data_buffer, new_samples])

                        # バッファが大きくなりすぎないよう管理（直近1分間のデータのみ保持）
                        max_buffer_size = SAMPLE_RATE * 60
                        if data_buffer.shape[0] > max_buffer_size:
                            data_buffer = data_buffer[-max_buffer_size:, :]

                    # メッセージを正常に処理したのでACKを返す
                    ch.basic_ack(delivery_tag=method.delivery_tag)
                except Exception as e:
                    print(f"RabbitMQコールバックでエラーが発生しました: {e}")
                    # エラーでもACKを返し、問題のあるメッセージが再送され続けないようにする
                    ch.basic_ack(delivery_tag=method.delivery_tag)

            channel.basic_consume(queue=queue_name, on_message_callback=callback)
            print("🚀 リアルタイム解析サービスが起動し、処理済みEEGデータの受信待機中です。")
            channel.start_consuming()
        except pika.exceptions.AMQPConnectionError:
            print("RabbitMQへの接続に失敗しました。5秒後に再試行します...")
            time.sleep(5)
        except Exception as e:
            print(
                f"予期せぬエラーでコンシューマスレッドが停止しました: {e}。5秒後に再起動します..."
            )
            time.sleep(5)


# --- API エンドポイント (Flask) ---
@app.route("/api/v1/analysis/results", methods=["GET"])
def get_analysis_results():
    """Flutterアプリがポーリングするための、最新の解析結果を返すエンドポイント。"""
    with analysis_lock:
        if not latest_analysis_results:
            return jsonify({"status": "解析結果はまだありません..."}), 202
        return jsonify(latest_analysis_results)


# --- アプリケーションの開始 ---
if __name__ == "__main__":
    # RabbitMQコンシューマと解析スレッドをバックグラウンドで開始
    threading.Thread(target=rabbitmq_consumer, daemon=True).start()
    threading.Thread(target=analysis_worker, daemon=True).start()

    # Flaskアプリを起動 (本番環境ではGunicornがこれを実行)
    # この部分は主にローカルでのデバッグ用
    print("Flask APIサーバーを http://0.0.0.0:5002 で起動します。")
    app.run(host="0.0.0.0", port=5002)
