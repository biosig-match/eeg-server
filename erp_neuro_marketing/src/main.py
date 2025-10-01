import os
from fastapi import FastAPI, HTTPException, Depends
from uuid import UUID
import logging
from fastapi.responses import JSONResponse

from src.schemas import AnalysisResponse
from src.auth import verify_owner_role
from src.analysis.orchestrator import run_full_analysis

# --- ロギング設定 ---
logging.basicConfig(level=logging.INFO, format='[%(asctime)s] [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

# --- 環境変数 ---
BIDS_EXPORTER_URL = os.getenv("BIDS_EXPORTER_URL", "http://bids_exporter:8000")
SHARED_VOLUME_PATH = os.getenv("SHARED_VOLUME_PATH", "/export_data")

# --- FastAPIアプリケーション ---
app = FastAPI(title="ERP Neuro-Marketing Service")

@app.get("/health", tags=["Health Check"], include_in_schema=False)
async def health_check():
    """A simple endpoint to confirm the service is running."""
    return JSONResponse(content={"status": "ok"})

@app.on_event("startup")
async def startup_event():
    """アプリケーション起動時のイベント"""
    logger.info("🚀 ERP Neuro-Marketing Service starting...")
    if not os.path.exists(SHARED_VOLUME_PATH):
        logger.warning(f"Shared volume path does not exist: {SHARED_VOLUME_PATH}")
    else:
        logger.info(f"Shared volume path is ready: {SHARED_VOLUME_PATH}")

@app.post(
    "/api/v1/neuro-marketing/experiments/{experiment_id}/analyze",
    response_model=AnalysisResponse,
    summary="指定された実験の脳波データを解析し、推奨事項を生成します。"
)
async def analyze_experiment(
    experiment_id: UUID,
    # 権限チェックをDI (Dependency Injection) を使用して実行
    authorized: bool = Depends(verify_owner_role)
):
    """
    指定された実験IDに基づいて、以下の処理を実行します。
    1. ユーザーが実験の `owner` であることを `auth_manager` に確認します。
    2. `bids_exporter` にBIDSデータセットの生成を依頼します。
    3. 生成されたBIDSデータセットを使用して、ERP解析と感情スペクトラム推定を実行します。
    4. 解析結果（推奨される刺激とサマリー）を返却します。

    :param experiment_id: 解析対象の実験ID
    :param authorized: `verify_owner_role` によって設定される認証結果
    :return: 解析結果を含むレスポンス
    """
    if not authorized:
        # このコードパスは通常 `verify_owner_role` によって防がれるが、念のため残す
        raise HTTPException(status_code=403, detail="Forbidden: User is not the owner of this experiment.")

    logger.info(f"Analysis requested for experiment_id: {experiment_id}")

    try:
        recommendations, summary = await run_full_analysis(
            experiment_id,
            BIDS_EXPORTER_URL,
            SHARED_VOLUME_PATH
        )

        return AnalysisResponse(
            experiment_id=experiment_id,
            summary=summary,
            recommendations=recommendations,
        )
    except HTTPException as http_exc:
        # サービス間通信やデータ不足のエラーをクライアントに転送
        logger.error(f"HTTP exception during analysis for {experiment_id}: {http_exc.detail}")
        raise http_exc
    except Exception as e:
        # 予期せぬ内部エラー
        logger.exception(f"An unexpected error occurred during analysis for experiment_id: {experiment_id}")
        raise HTTPException(status_code=500, detail=f"An internal error occurred: {str(e)}")

