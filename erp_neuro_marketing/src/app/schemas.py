from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class ProductRecommendation(BaseModel):
    """A single recommended product's details."""

    file_name: str
    item_name: str | None = None
    brand_name: str | None = None
    description: str | None = None
    category: str | None = None
    gender: str | None = None


class AnalysisResponse(BaseModel):
    """The final response from the neuro-marketing analysis."""

    experiment_id: UUID = Field(..., description="The ID of the analyzed experiment.")
    recommendations: list[ProductRecommendation] = Field(
        ..., description="List of recommended products based on ERP analysis."
    )
    summary: str = Field(..., description="AI-generated summary of the user's preferences.")


class AnalysisResultSnapshot(BaseModel):
    """Persisted analysis result that can be retrieved later."""

    analysis_id: int = Field(..., description="Unique identifier for the stored analysis result.")
    experiment_id: UUID
    summary: str
    recommendations: list[ProductRecommendation]
    generated_at: datetime | None = Field(
        None, description="Timestamp when the analysis completed (UTC)."
    )
    requested_by_user_id: str
