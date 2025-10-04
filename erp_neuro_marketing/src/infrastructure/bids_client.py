from uuid import UUID

import httpx

from ..config.env import settings

class BidsCreationError(Exception):
    """Custom exception for BIDS creation failures."""
    pass

async def request_bids_creation(experiment_id: UUID) -> dict:
    """
    Requests the BIDS Exporter service to create a BIDS dataset for analysis.
    """
    request_url = f"{settings.bids_exporter_url}/internal/v1/create-bids-for-analysis"
    payload = {"experiment_id": str(experiment_id)}
    
    # 解析は時間がかかる可能性があるため、タイムアウトを長めに設定
    timeout = httpx.Timeout(300.0, connect=10.0)
    
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            response = await client.post(request_url, json=payload)
            
            if response.status_code == 200:
                return response.json()
            else:
                error_detail = response.text
                raise BidsCreationError(f"BIDS Exporter returned status {response.status_code}: {error_detail}")
        except httpx.RequestError as e:
            raise BidsCreationError(f"Failed to communicate with BIDS Exporter: {e}")
