import asyncio
from minio import Minio as S3CompatibleClient

from ..config.env import settings


object_storage_client = S3CompatibleClient(
    endpoint=f"{settings.object_storage_endpoint}:{settings.object_storage_port}",
    access_key=settings.object_storage_access_key,
    secret_key=settings.object_storage_secret_key,
    secure=settings.object_storage_use_ssl,
)

RAW_DATA_BUCKET = settings.object_storage_raw_data_bucket
MEDIA_BUCKET = settings.object_storage_media_bucket
BIDS_BUCKET = settings.object_storage_bids_exports_bucket


async def check_object_storage_connection() -> None:
    """Ensure the object storage connection succeeds and the BIDS bucket exists."""
    print("Checking object storage connection and bucket status...")
    loop = asyncio.get_event_loop()
    try:
        found = await loop.run_in_executor(None, object_storage_client.bucket_exists, BIDS_BUCKET)
        if not found:
            print(f"Bucket '{BIDS_BUCKET}' not found. Creating it...")
            await loop.run_in_executor(None, object_storage_client.make_bucket, BIDS_BUCKET)
            print(f"Bucket '{BIDS_BUCKET}' created successfully.")
        else:
            print(f"Bucket '{BIDS_BUCKET}' already exists.")

        print("✅ Object storage connection is OK.")

    except Exception as exc:  # noqa: BLE001
        print(f"❌ FATAL: Could not connect to object storage or set up the bucket: {exc}")
        raise
