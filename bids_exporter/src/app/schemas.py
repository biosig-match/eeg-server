from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    """Schema for the health check response."""

    status: str = "ok"


class TaskStatus(BaseModel):
    """Detailed status of an export task."""

    task_id: UUID
    experiment_id: UUID
    status: str = Field(..., description="e.g., pending, processing, completed, failed")
    progress: int = Field(..., ge=0, le=100, description="Task completion percentage")
    created_at: datetime
    updated_at: datetime
    result_file_path: str | None = Field(
        None, description="Path to the final ZIP file in the object storage"
    )
    error_message: str | None = None

    class Config:
        from_attributes = True


class ExportResponse(BaseModel):
    """Response returned when a new export task is initiated."""

    task_id: UUID
    status: str
    message: str
    status_url: str = Field(..., description="URL to poll for task status")


# --- Internal API Schemas ---
class InternalBidsRequest(BaseModel):
    """Schema for the internal request from erp_neuro_marketing service."""

    experiment_id: UUID


class InternalBidsResponse(BaseModel):
    """Schema for the internal response to erp_neuro_marketing service."""

    experiment_id: UUID
    bids_path: str = Field(
        ...,
        description=("The absolute path to the generated BIDS dataset in the shared volume."),
    )
    message: str
