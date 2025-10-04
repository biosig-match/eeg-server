import logging
from uuid import UUID

import httpx
from fastapi import Header, HTTPException

from ...config.env import settings

# --- ロガー設定 ---
logger = logging.getLogger(__name__)

async def verify_owner_role(
    experiment_id: UUID,
    x_user_id: str | None = Header(None, alias="X-User-Id"),
) -> bool:
    """
    FastAPIのDI（Dependency Injection）として使用される関数。
    Auth Managerサービスに問い合わせて、ユーザーが指定された実験の'owner'であることを確認します。
    """
    if not x_user_id:
        logger.warning(f"Authorization check failed for experiment {experiment_id}: X-User-Id header is missing.")
        raise HTTPException(
            status_code=401,
            detail="Unauthorized: X-User-Id header is required."
        )

    auth_check_url = f"{settings.auth_manager_url}/api/v1/auth/check"
    payload = {
        "user_id": x_user_id,
        "experiment_id": str(experiment_id),
        "required_role": "owner"
    }

    try:
        async with httpx.AsyncClient() as client:
            # ★★★ 修正箇所: タイムアウトを明示的に10秒に設定 ★★★
            response = await client.post(auth_check_url, json=payload, timeout=10.0)

        if response.status_code == 200:
            if response.json().get("authorized"):
                logger.info(f"User '{x_user_id}' is authorized as owner for experiment '{experiment_id}'.")
                return True
        
        if response.status_code in [403, 404]:
            error_detail = response.json().get("error", "Authorization failed.")
            logger.warning(f"Authorization failed for user '{x_user_id}' on experiment '{experiment_id}': {error_detail}")
            raise HTTPException(status_code=response.status_code, detail=error_detail)

        logger.error(f"Auth service returned unexpected status {response.status_code}: {response.text}")
        raise HTTPException(status_code=503, detail="Authorization service returned an unexpected error.")

    except httpx.RequestError:
        logger.exception(f"Could not connect to the authorization service at {auth_check_url}.")
        raise HTTPException(
            status_code=503,
            detail="Service Unavailable: Could not communicate with authorization service."
        )
    
    raise HTTPException(status_code=403, detail="Forbidden: You do not have the required permissions.")
