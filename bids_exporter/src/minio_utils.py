import os
import asyncio
from minio import Minio

# --- 環境変数から設定を読み込み ---
MINIO_INTERNAL_ENDPOINT = os.getenv("MINIO_ENDPOINT", "minio:9000")
# MINIO_PUBLIC_ENDPOINT は不要になったため削除
MINIO_ACCESS_KEY = os.getenv("MINIO_ACCESS_KEY")
MINIO_SECRET_KEY = os.getenv("MINIO_SECRET_KEY")
MINIO_USE_SSL = os.getenv("MINIO_USE_SSL", "false").lower() == "true"

# --- MinIO クライアントの初期化 ---

# サービス内部での通信にのみ使用するクライアント
minio_client = Minio(
    endpoint=MINIO_INTERNAL_ENDPOINT,
    access_key=MINIO_ACCESS_KEY,
    secret_key=MINIO_SECRET_KEY,
    secure=MINIO_USE_SSL,
)

# public_minio_client は不要になったため削除

# --- 定数 ---
RAW_DATA_BUCKET = os.getenv("MINIO_RAW_DATA_BUCKET")
MEDIA_BUCKET = os.getenv("MINIO_MEDIA_BUCKET")
BIDS_BUCKET = os.getenv("MINIO_BIDS_EXPORTS_BUCKET", "bids-exports")

async def check_minio_connection():
    """
    MinIOへの接続を確認し、BIDSバケットが存在することを保証します。
    """
    print("Checking MinIO connection and bucket status...")
    loop = asyncio.get_event_loop()
    try:
        def bucket_exists_sync(bucket_name):
            return minio_client.bucket_exists(bucket_name)

        found = await loop.run_in_executor(None, bucket_exists_sync, BIDS_BUCKET)

        if not found:
            print(f"Bucket '{BIDS_BUCKET}' not found. Creating it...")
            await loop.run_in_executor(None, minio_client.make_bucket, BIDS_BUCKET)
            print(f"Bucket '{BIDS_BUCKET}' created successfully.")
        else:
            print(f"Bucket '{BIDS_BUCKET}' already exists.")

        print("✅ MinIO connection is OK.")

    except Exception as e:
        print(f"❌ FATAL: Could not connect to MinIO or set up the bucket: {e}")
        raise

