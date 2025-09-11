import base64
import json
import os
import struct
from datetime import UTC, datetime, timedelta

import numpy as np
import pika
import psycopg
import zstandard

# --- 環境変数 ---
RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@rabbitmq:5672")
DATABASE_URL = os.getenv("DATABASE_URL", "postgres://admin:password@db:5432/erp_data")

# --- 定数 ---
ESP32_SENSOR_FORMAT = "<" + "H" * 8 + "f" * 3 + "f" * 3 + "B" + "b" * 8 + "I"
ESP32_SENSOR_SIZE = struct.calcsize(ESP32_SENSOR_FORMAT)

# NumPy structured dtype (little-endian) matching ESP32 payload layout
ESP32_DTYPE = np.dtype(
    [
        ("eeg", "<u2", (8,)),
        ("accel", "<f4", (3,)),
        ("gyro", "<f4", (3,)),
        ("trig", "u1"),
        ("imp", "i1", (8,)),
        ("esp", "<u4"),
    ]
)
DEVICE_BOOT_TIME_ESTIMATES = {}


# --- データベース接続 ---
def get_db_connection():
    """データベースへの接続を取得します。"""
    # psycopg (v3)
    return psycopg.connect(DATABASE_URL)


def parse_iso_dt(value: str) -> datetime:
    """ISO8601を厳密すぎない形でdatetimeへ変換（'Z'も許容）。"""
    if not isinstance(value, str):
        return datetime.now()
    v = value.strip()
    if v.endswith("Z"):
        v = v[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(v)
    except Exception:
        return datetime.now()

# --- 現在進行中の実験IDを取得するヘルパー関数 ---
def get_active_experiment_id(db_conn, device_id):
    """指定されたデバイスIDで現在進行中（end_timeがNULL）の実験IDを返す"""
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT experiment_id FROM experiments WHERE device_id = %s AND end_time IS NULL ORDER BY start_time DESC LIMIT 1",
            (device_id,),
        )
        result = cur.fetchone()
        return result[0] if result else None




def process_raw_eeg_message_v2(channel, method, properties, body, db_conn):
    """EEG/IMU生データ（v2: application/octet-stream + zstd, headersにメタ）を処理。"""
    try:
        headers = getattr(properties, "headers", {}) or {}
        device_id = headers.get("device_id", "unknown")
        # タイムスタンプ: ヘッダ優先、なければ AMQP timestamp、さらになければ現在時刻
        ts_str = headers.get("server_received_timestamp")
        if ts_str:
            server_received_timestamp = parse_iso_dt(ts_str)
        elif getattr(properties, "timestamp", None):
            server_received_timestamp = datetime.fromtimestamp(properties.timestamp)
        else:
            server_received_timestamp = datetime.now()

        # 現在進行中の実験IDを取得
        active_experiment_id = get_active_experiment_id(db_conn, device_id)

        raw_bytes = zstandard.ZstdDecompressor().decompress(body)

        num_samples = len(raw_bytes) // ESP32_SENSOR_SIZE
        if num_samples == 0:
            channel.basic_ack(delivery_tag=method.delivery_tag)
            return

        arr = np.frombuffer(raw_bytes, dtype=ESP32_DTYPE, count=num_samples)
        esp_u32 = arr["esp"]
        latest_esp_micros = int(esp_u32[-1])
        esp_boot_time_server = server_received_timestamp - timedelta(microseconds=latest_esp_micros)
        DEVICE_BOOT_TIME_ESTIMATES[device_id] = esp_boot_time_server

        timestamps = [
            esp_boot_time_server + timedelta(microseconds=int(us)) for us in esp_u32.tolist()
        ]

        eeg_values_2d = arr["eeg"].tolist()
        accel_2d = arr["accel"].astype(np.float64).tolist()
        gyro_2d = arr["gyro"].astype(np.float64).tolist()
        trig_1d = arr["trig"].tolist()
        imp_2d = arr["imp"].tolist()

        eeg_rows = [
            (
                timestamps[i],
                device_id,
                active_experiment_id,
                eeg_values_2d[i],
                imp_2d[i],
                int(trig_1d[i]),
            )
            for i in range(num_samples)
        ]
        imu_rows = [
            (
                timestamps[i],
                device_id,
                active_experiment_id,
                accel_2d[i],
                gyro_2d[i],
            )
            for i in range(num_samples)
        ]

        with db_conn.cursor() as cur:
            with cur.copy(
                "COPY eeg_raw_data (timestamp, device_id, experiment_id, eeg_values, impedance_values, trigger_value) FROM STDIN WITH (FORMAT text)"
            ) as cp:
                for row in eeg_rows:
                    cp.write_row(row)
            with cur.copy(
                "COPY imu_raw_data (timestamp, device_id, experiment_id, accel_values, gyro_values) FROM STDIN WITH (FORMAT text)"
            ) as cp:
                for row in imu_rows:
                    cp.write_row(row)
        db_conn.commit()

        processed_message = {"device_id": device_id, "eeg_data": [row[3] for row in eeg_rows]}
        channel.basic_publish(
            exchange="processed_data_exchange",
            routing_key="eeg.processed",
            body=json.dumps(processed_message),
        )

        channel.basic_ack(delivery_tag=method.delivery_tag)

    except Exception as e:
        print(f"EEG(v2)データ処理中にエラーが発生しました: {e}")
        try:
            db_conn.rollback()
        except Exception:
            pass
        try:
            channel.basic_nack(delivery_tag=method.delivery_tag, requeue=True)
        except Exception:
            pass


def process_media_message(channel, method, properties, body, db_conn):
    """メディアファイル（画像・音声）を処理するコールバック関数"""
    try:
        message = json.loads(body)
        device_id = message["device_id"]
        active_experiment_id = get_active_experiment_id(db_conn, device_id)
        timestamp = datetime.fromtimestamp(message["timestamp_ms"] / 1000.0, tz=UTC)

        with db_conn.cursor() as cur:
            cur.execute(
                "INSERT INTO media_files (timestamp, device_id, epoch_id, experiment_id, image_data, audio_data, metadata) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (
                    timestamp,
                    device_id,
                    message["epoch_id"],
                    active_experiment_id,
                    base64.b64decode(message["image"]["payload"]) if message.get("image") else None,
                    base64.b64decode(message["audio"]["payload"]) if message.get("audio") else None,
                    json.dumps(
                        {
                            "image_mimetype": message["image"]["mimetype"]
                            if message.get("image")
                            else None,
                            "audio_mimetype": message["audio"]["mimetype"]
                            if message.get("audio")
                            else None,
                        }
                    ),
                ),
            )
            db_conn.commit()
    except Exception as e:
        print(f"メディアデータ処理中にエラーが発生しました: {e}")
    finally:
        channel.basic_ack(delivery_tag=method.delivery_tag)


def main():
    db_conn = get_db_connection()
    connection = pika.BlockingConnection(pika.URLParameters(RABBITMQ_URL))
    channel = connection.channel()

    channel.exchange_declare(exchange="raw_data_exchange", exchange_type="topic", durable=True)
    channel.exchange_declare(
        exchange="processed_data_exchange", exchange_type="topic", durable=True
    )
    channel.queue_declare(queue="processing_queue", durable=True)
    channel.queue_bind(exchange="raw_data_exchange", queue="processing_queue", routing_key="#")
    channel.basic_qos(prefetch_count=1)

    def callback(ch, method, properties, body):
        routing_key = method.routing_key
        if routing_key == "eeg.raw":
            process_raw_eeg_message_v2(ch, method, properties, body, db_conn)
        elif routing_key == "media.raw":
            process_media_message(ch, method, properties, body, db_conn)
        else:
            ch.basic_ack(delivery_tag=method.delivery_tag)

    channel.basic_consume(queue="processing_queue", on_message_callback=callback)
    print("🚀 Processorサービスが起動し、生データの受信待機中です...")
    channel.start_consuming()


if __name__ == "__main__":
    main()
