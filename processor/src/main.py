import base64
import json
import os
import struct
from datetime import UTC, datetime, timedelta

import pika
import psycopg2
import psycopg2.extras
import zstandard

# --- 環境変数 ---
RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@rabbitmq:5672")
DATABASE_URL = os.getenv("DATABASE_URL", "postgres://admin:password@db:5432/erp_data")

# --- 定数 ---
ESP32_SENSOR_FORMAT = "<" + "H" * 8 + "f" * 3 + "f" * 3 + "B" + "b" * 8 + "I"
ESP32_SENSOR_SIZE = struct.calcsize(ESP32_SENSOR_FORMAT)
DEVICE_BOOT_TIME_ESTIMATES = {}


# --- データベース接続 ---
def get_db_connection():
    """データベースへの接続を取得します。"""
    return psycopg2.connect(DATABASE_URL)


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


def process_raw_eeg_message(channel, method, properties, body, db_conn):
    """EEG/IMU生データパケットを処理するコールバック関数"""
    try:
        message = json.loads(body)
        device_id = message["device_id"]
        server_received_timestamp = datetime.fromisoformat(message["server_received_timestamp"])

        # 現在進行中の実験IDを取得
        active_experiment_id = get_active_experiment_id(db_conn, device_id)

        compressed_data = base64.b64decode(message["payload"])
        raw_bytes = zstandard.ZstdDecompressor().decompress(compressed_data)

        num_samples = len(raw_bytes) // ESP32_SENSOR_SIZE
        if num_samples == 0:
            channel.basic_ack(delivery_tag=method.delivery_tag)
            return

        latest_esp_micros = struct.unpack_from(
            "<I", raw_bytes, (num_samples - 1) * ESP32_SENSOR_SIZE + (ESP32_SENSOR_SIZE - 4)
        )[0]
        esp_boot_time_server = server_received_timestamp - timedelta(microseconds=latest_esp_micros)
        DEVICE_BOOT_TIME_ESTIMATES[device_id] = esp_boot_time_server

        eeg_records, imu_records = [], []

        for i in range(num_samples):
            offset = i * ESP32_SENSOR_SIZE
            unpacked_data = struct.unpack_from(ESP32_SENSOR_FORMAT, raw_bytes, offset)

            eeg_values, accel_values, gyro_values, trigger, impedance_values, esp_micros = (
                list(unpacked_data[0:8]),
                list(unpacked_data[8:11]),
                list(unpacked_data[11:14]),
                unpacked_data[14],
                list(unpacked_data[15:23]),
                unpacked_data[23],
            )

            record_timestamp = esp_boot_time_server + timedelta(microseconds=esp_micros)

            # レコードに実験IDを追加
            eeg_records.append(
                (
                    record_timestamp,
                    device_id,
                    active_experiment_id,
                    eeg_values,
                    impedance_values,
                    trigger,
                )
            )
            imu_records.append(
                (record_timestamp, device_id, active_experiment_id, accel_values, gyro_values)
            )

        with db_conn.cursor() as cur:
            psycopg2.extras.execute_values(
                cur,
                "INSERT INTO eeg_raw_data (timestamp, device_id, experiment_id, eeg_values, impedance_values, trigger_value) VALUES %s",
                eeg_records,
            )
            psycopg2.extras.execute_values(
                cur,
                "INSERT INTO imu_raw_data (timestamp, device_id, experiment_id, accel_values, gyro_values) VALUES %s",
                imu_records,
            )
            db_conn.commit()

        processed_message = {"device_id": device_id, "eeg_data": [rec[3] for rec in eeg_records]}
        channel.basic_publish(
            exchange="processed_data_exchange",
            routing_key="eeg.processed",
            body=json.dumps(processed_message),
        )

    except Exception as e:
        print(f"EEGデータ処理中にエラーが発生しました: {e}")
    finally:
        channel.basic_ack(delivery_tag=method.delivery_tag)


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
            process_raw_eeg_message(ch, method, properties, body, db_conn)
        elif routing_key == "media.raw":
            process_media_message(ch, method, properties, body, db_conn)
        else:
            ch.basic_ack(delivery_tag=method.delivery_tag)

    channel.basic_consume(queue="processing_queue", on_message_callback=callback)
    print("🚀 Processorサービスが起動し、生データの受信待機中です...")
    channel.start_consuming()


if __name__ == "__main__":
    main()
