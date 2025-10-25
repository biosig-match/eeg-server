import asyncio
import os
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import BackgroundTasks, FastAPI, HTTPException, Response
from fastapi.responses import StreamingResponse
from minio.error import S3Error

from ..config.env import settings
from ..domain.bids import create_bids_dataset
from ..domain.tasks import create_task_in_db, get_task_status
from ..infrastructure.object_storage import (
    BIDS_BUCKET,
    check_object_storage_connection,
    object_storage_client,
)
from .schemas import (
    ExportResponse,
    HealthResponse,
    InternalBidsRequest,
    InternalBidsResponse,
    TaskStatus,
)

EXPORT_OUTPUT_DIR = Path(settings.export_output_dir)

# Initialize FastAPI app
app = FastAPI(title="BIDS Exporter Service")


@app.on_event("startup")
async def startup_event():
    """On startup, check the connection to the object storage and ensure the bucket exists."""
    try:
        await check_object_storage_connection()
        EXPORT_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        print(f"FATAL: Could not connect to object storage on startup. {e}")
        # In a real-world scenario, you might want to exit if the object storage is unavailable.
        # os._exit(1)


@app.get("/health", response_model=HealthResponse, tags=["Health"])
async def health_check(response: Response):
    """A simple endpoint to confirm the service is running for health checks."""
    try:
        # オブジェクトストレージ接続チェック
        loop = asyncio.get_event_loop()
        storage_ok = await loop.run_in_executor(
            None, lambda: object_storage_client.bucket_exists(BIDS_BUCKET)
        )
        if not storage_ok:
            response.status_code = 503
            return HealthResponse(status="unhealthy")
        return HealthResponse(status="ok")
    except Exception:
        response.status_code = 503
        return HealthResponse(status="unhealthy")


@app.get("/api/v1/health", response_model=HealthResponse, tags=["Health"])
async def health_check_v1(response: Response):
    """Versioned health endpoint kept in sync with legacy /health route."""
    return await health_check(response)


@app.post(
    "/api/v1/experiments/{experiment_id}/export",
    response_model=ExportResponse,
    status_code=202,
)
async def start_export(experiment_id: UUID, background_tasks: BackgroundTasks):
    """
    Starts a new BIDS export task for a given experiment, compressing the result into a ZIP file.
    The actual processing is done in the background.
    """
    task_id = uuid4()

    create_task_in_db(task_id, experiment_id)

    # Schedule the background task with zip_output=True
    background_tasks.add_task(
        create_bids_dataset,
        experiment_id=experiment_id,
        task_id=task_id,
        output_dir=EXPORT_OUTPUT_DIR,
        zip_output=True,
    )

    status_url = f"/api/v1/export-tasks/{task_id}"
    return ExportResponse(
        task_id=task_id,
        status="pending",
        message=("BIDS export task has been accepted and is running in the background."),
        status_url=status_url,
    )


@app.get("/api/v1/export-tasks/{task_id}", response_model=TaskStatus)
def get_export_status(task_id: UUID):
    """
    Retrieves the status of a specific export task from the database.
    """
    task = get_task_status(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@app.get("/api/v1/export-tasks/{task_id}/download")
def download_export(task_id: UUID):
    """
    Downloads the completed BIDS dataset by streaming it from the object storage
    through this service.
    """
    task = get_task_status(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")

    if not isinstance(task, TaskStatus):
        return task

    if task.status != "completed" or not task.result_file_path:
        raise HTTPException(
            status_code=400,
            detail=f"Task is not complete. Current status: {task.status}",
        )

    try:
        headers = {
            "Content-Disposition": (
                f'attachment; filename="{os.path.basename(task.result_file_path)}"'
            )
        }

        # Generator function to stream the file from the object storage
        def stream_object_storage_object(bucket: str, object_name: str):
            response = None
            try:
                response = object_storage_client.get_object(bucket, object_name)
                yield from response.stream(32 * 1024)
            finally:
                if response:
                    response.close()
                    response.release_conn()

        return StreamingResponse(
            stream_object_storage_object(BIDS_BUCKET, os.path.basename(task.result_file_path)),
            media_type="application/zip",
            headers=headers,
        )

    except S3Error as e:
        if e.code == "NoSuchKey":
            raise HTTPException(
                status_code=404,
                detail=f"File not found in storage: {task.result_file_path}",
            ) from e
        print(f"S3 Error when trying to stream file for task {task_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Storage error: {e.code}") from e
    except Exception as e:
        print(f"Error streaming file for task {task_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Could not retrieve file: {e}") from e


# --- Internal Endpoint for erp_neuro_marketing service ---
@app.post("/internal/v1/create-bids-for-analysis", response_model=InternalBidsResponse)
async def create_bids_for_analysis(request: InternalBidsRequest):
    """
    An internal endpoint that creates a BIDS dataset without zipping it,
    saving it to a shared volume for another service to analyze.
    This is a synchronous, blocking call intended for service-to-service communication.
    """
    task_id = uuid4()  # Create a temporary task ID for logging/tracking
    print(
        "[Internal] Starting BIDS creation for analysis. "
        f"Task: {task_id}, Exp: {request.experiment_id}"
    )
    try:
        # Call the logic function directly with zip_output=False
        output_path = create_bids_dataset(
            experiment_id=request.experiment_id,
            task_id=task_id,
            output_dir=EXPORT_OUTPUT_DIR,
            zip_output=False,
        )
        if not output_path:
            raise HTTPException(
                status_code=500,
                detail="BIDS dataset creation failed to return a valid path.",
            )

        print(f"[Internal] BIDS data generated at: {output_path} for Exp: {request.experiment_id}")
        return InternalBidsResponse(
            experiment_id=request.experiment_id,
            bids_path=output_path,
            message="BIDS dataset created successfully for analysis.",
        )
    except ValueError as e:
        # Handle specific known errors like "Experiment not found" or "No sessions"
        print(f"[Internal] Value Error for Exp {request.experiment_id}: {e}")
        raise HTTPException(status_code=404, detail=str(e)) from e
    except Exception as e:
        print(f"❌ [Internal] BIDS creation failed for task {task_id}: {e}")
        import traceback

        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Failed to generate BIDS dataset: {e}",
        ) from e
