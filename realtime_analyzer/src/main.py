import base64
import io
import os
import struct
import threading
import time
from collections import defaultdict
from datetime import datetime

import matplotlib
import matplotlib.pyplot as plt
import mne
import numpy as np
import pika
import zstandard
from flask import Flask, jsonify
from mne_connectivity import spectral_connectivity_epochs
from mne_connectivity.viz import plot_connectivity_circle

# MatplotlibがGUIのないサーバー環境で動作するための設定
matplotlib.use("Agg")

# --- Flaskアプリケーションとグローバル変数 ---
app = Flask(__name__)
latest_analysis_results = defaultdict(dict)
user_data_buffers = defaultdict(lambda: np.array([]))
analysis_lock = threading.Lock()
buffer_lock = threading.Lock()

# --- 定数と設定 (環境変数から取得) ---
RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@rabbitmq:5672")
SAMPLE_RATE = int(os.getenv("SAMPLE_RATE", "256"))
NUM_EEG_CHANNELS = 8
ANALYSIS_WINDOW_SEC = 2.0
ANALYSIS_WINDOW_SAMPLES = int(SAMPLE_RATE * ANALYSIS_WINDOW_SEC)
CHANNEL_NAMES = ["Fp1", "Fp2", "F7", "F8", "T7", "T8", "P7", "P8"]

# MNEライブラリ用の情報オブジェクトを事前に作成
mne_info = mne.create_info(ch_names=CHANNEL_NAMES, sfreq=SAMPLE_RATE, ch_types="eeg")
try:
    mne_info.set_montage("standard_1020", on_missing="warn")
except Exception as e:
    print(f"警告: 電極位置(Montage)の設定に失敗しました。エラー: {e}")

# --- ヘルパー関数 ---
def fig_to_base64(fig):
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight", pad_inches=0.1)
    plt.close(fig)
    buf.seek(0)
    return base64.b64encode(buf.getvalue()).decode("utf-8")

# --- バックグラウンド処理スレッド ---
def analysis_worker():
    """
    バックグラウンドで定期的に実行され、各ユーザーのバッファから脳波解析を行います。
    """
    global latest_analysis_results
    print("✅ 解析ワーカースレッドが起動しました。")
    while True:
        time.sleep(10)
        with buffer_lock:
            current_buffers = dict(user_data_buffers)
        for user_id, buffer in current_buffers.items():
            if buffer.shape[0] < ANALYSIS_WINDOW_SAMPLES:
                continue
            data_chunk = buffer[-ANALYSIS_WINDOW_SAMPLES:, :]
            try:
                # 単位を[V]に変換
                data_in_volts = (data_chunk.T.astype(np.float64) - 2048.0) * (4.5 / 4096.0) * 1e-6
                raw = mne.io.RawArray(data_in_volts, mne_info, verbose=False)

                # 1. PSD (パワースペクトル密度) の計算と描画
                fig_psd = raw.compute_psd(fmin=1, fmax=45, n_fft=SAMPLE_RATE, verbose=False).plot(
                    show=False, spatial_colors=True
                )
                psd_b64 = fig_to_base64(fig_psd)

                # 2. Coherence (コヒーレンス) の計算と描画
                epochs = mne.make_fixed_length_epochs(
                    raw, duration=ANALYSIS_WINDOW_SEC, preload=True, verbose=False
                )
                con = spectral_connectivity_epochs(
                    epochs, method="coh", sfreq=SAMPLE_RATE, fmin=8, fmax=13, faverage=True, verbose=False
                )
                
                # <<< 修正点 >>>
                # get_data()は(1, 8, 8)の3D配列を返すため、squeeze()で(8, 8)の2D配列に変換する
                con_matrix = np.squeeze(con.get_data(output="dense"))
                
                fig_coh, _ = plot_connectivity_circle(
                    con_matrix, CHANNEL_NAMES, show=False, vmin=0, vmax=1
                )
                coh_b64 = fig_to_base64(fig_coh)

                # 結果を保存
                with analysis_lock:
                    latest_analysis_results[user_id] = {
                        "psd_image": psd_b64,
                        "coherence_image": coh_b64,
                        "timestamp": datetime.now().isoformat(),
                    }
                print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] ユーザー({user_id})の解析結果を更新しました。")
            except Exception as e:
                print(f"ユーザー({user_id})の解析中にエラーが発生しました: {e}")

def rabbitmq_consumer():
    """
    RabbitMQから圧縮生データを受信し、ユーザーごとのバッファに追加します。
    """
    global user_data_buffers
    zstd_decompressor = zstandard.ZstdDecompressor()
    # ❗注意: 以下の定数はデータを送信する側の実装と一致している必要があります。
    # もし一致していない場合、"Data corruption"エラーが発生します。
    HEADER_SIZE = 18
    POINT_SIZE = 53
    while True:
        try:
            connection = pika.BlockingConnection(pika.URLParameters(RABBITMQ_URL))
            channel = connection.channel()
            channel.exchange_declare(exchange="raw_data_exchange", exchange_type="fanout", durable=True)
            result = channel.queue_declare(queue="", exclusive=True)
            queue_name = result.method.queue
            channel.queue_bind(exchange="raw_data_exchange", queue=queue_name)
            def callback(ch, method, properties, body):
                global user_data_buffers
                try:
                    if not properties.headers or 'user_id' not in properties.headers:
                        print("警告: user_idがヘッダーに含まれていないメッセージを破棄しました。")
                        ch.basic_ack(delivery_tag=method.delivery_tag)
                        return
                    user_id = properties.headers['user_id']
                    
                    # データを解凍
                    decompressed_data = zstd_decompressor.decompress(body)

                    # --- データ構造の解釈 ---
                    num_points = (len(decompressed_data) - HEADER_SIZE) // POINT_SIZE
                    if num_points <= 0:
                        ch.basic_ack(delivery_tag=method.delivery_tag)
                        return
                    eeg_samples = []
                    for i in range(num_points):
                        offset = HEADER_SIZE + (i * POINT_SIZE)
                        # '<' はリトルエンディアン, 'H' は符号なしshort (2バイト)
                        eeg_point = struct.unpack_from('<' + 'H' * NUM_EEG_CHANNELS, decompressed_data, offset)
                        eeg_samples.append(eeg_point)
                    new_samples = np.array(eeg_samples, dtype=np.uint16)
                    # -------------------------

                    # ユーザー毎のバッファにデータを追加
                    with buffer_lock:
                        current_buffer = user_data_buffers[user_id]
                        if current_buffer.size == 0:
                            user_data_buffers[user_id] = new_samples
                        else:
                            user_data_buffers[user_id] = np.vstack([current_buffer, new_samples])
                        
                        # バッファが大きくなりすぎないように制御 (60秒分)
                        max_buffer_size = SAMPLE_RATE * 60
                        if user_data_buffers[user_id].shape[0] > max_buffer_size:
                            user_data_buffers[user_id] = user_data_buffers[user_id][-max_buffer_size:, :]
                    
                    ch.basic_ack(delivery_tag=method.delivery_tag)
                except zstandard.ZstdError as e:
                    print(f"RabbitMQコールバックでZstandard解凍エラー: {e}。送信データ形式を確認してください。")
                    ch.basic_ack(delivery_tag=method.delivery_tag) # エラーでもメッセージはACKする
                except Exception as e:
                    print(f"RabbitMQコールバックで予期せぬエラー: {e}")
                    ch.basic_ack(delivery_tag=method.delivery_tag)

            channel.basic_consume(queue=queue_name, on_message_callback=callback)
            print("🚀 リアルタイム解析サービスが起動し、圧縮生データの受信待機中です。")
            channel.start_consuming()
        except pika.exceptions.AMQPConnectionError:
            print("RabbitMQへの接続に失敗... 5秒後に再試行します。")
            time.sleep(5)
        except Exception as e:
            print(f"予期せぬエラーでコンシューマが停止: {e}。5秒後に再起動します...")
            time.sleep(5)

# --- API エンドポイント (Flask) ---
@app.route("/api/v1/users/<user_id>/analysis", methods=["GET"])
def get_analysis_results(user_id: str):
    """ユーザーIDに対応する最新の解析結果を返すエンドポイント。"""
    with analysis_lock:
        user_results = latest_analysis_results.get(user_id)
        if not user_results:
            return jsonify({"status": f"ユーザー({user_id})の解析結果はまだありません..."}), 202
        return jsonify(user_results)

# Gunicornがこのファイルをインポートした時点で、バックグラウンドスレッドを開始します。
# Gunicornのワーカーが1つでない場合、このスレッドはワーカーの数だけ起動します。
threading.Thread(target=rabbitmq_consumer, daemon=True).start()
threading.Thread(target=analysis_worker, daemon=True).start()

# --- アプリケーションの開始 ---
if __name__ == "__main__":
    # この部分は、'python main.py'と直接実行した時(ローカル開発時)にのみ使われます。
    print("Flask APIサーバーを http://0.0.0.0:5002 で起動します（開発モード）。")
    app.run(host="0.0.0.0", port=5002)