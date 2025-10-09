from pydantic import BaseModel, Field
from uuid import UUID
from typing import List, Optional

class ProductRecommendation(BaseModel):
    """A single recommended product's details."""
    file_name: str
    item_name: Optional[str] = None
    brand_name: Optional[str] = None
    description: Optional[str] = None
    category: Optional[str] = None
    gender: Optional[str] = None

class AnalysisResponse(BaseModel):
    """The final response from the neuro-marketing analysis."""
    experiment_id: UUID = Field(..., description="The ID of the analyzed experiment.")
    recommendations: List[ProductRecommendation] = Field(..., description="List of recommended products based on ERP analysis.")
    summary: str = Field(..., description="AI-generated summary of the user's preferences.")
