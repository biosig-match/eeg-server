import asyncio
from minio import Minio

from ..config.env import settings

minio_client = Minio(
    endpoint=settings.minio_endpoint,
    access_key=settings.minio_access_key,
    secret_key=settings.minio_secret_key,
    secure=settings.minio_use_ssl,
)

RAW_DATA_BUCKET = settings.minio_raw_data_bucket
MEDIA_BUCKET = settings.minio_media_bucket
BIDS_BUCKET = settings.minio_bids_exports_bucket

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
