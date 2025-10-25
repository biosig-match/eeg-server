import logging
from pathlib import Path
from uuid import UUID

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from ..config.env import settings
from ..domain.analysis.orchestrator import run_full_analysis
from ..infrastructure.db import get_latest_analysis_result, save_analysis_result
from .dependencies.auth import verify_owner_role
from .schemas import AnalysisResponse, AnalysisResultSnapshot, ProductRecommendation

# --- ロギング設定 ---
logging.basicConfig(level=logging.INFO, format="[%(asctime)s] [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

# --- FastAPIアプリケーション ---
app = FastAPI(title="ERP Neuro-Marketing Service")


def _build_health_response() -> JSONResponse:
    """Generate a consistent health payload for both legacy and versioned endpoints."""
    return JSONResponse(content={"status": "ok"})


@app.get("/health", tags=["Health Check"], include_in_schema=False)
async def health_check():
    """A simple endpoint to confirm the service is running."""
    return _build_health_response()


@app.get("/api/v1/health", tags=["Health Check"], include_in_schema=False)
async def health_check_v1():
    """Versioned health endpoint kept in sync with /health."""
    return _build_health_response()


@app.on_event("startup")
async def startup_event():
    """アプリケーション起動時のイベント"""
    logger.info("🚀 ERP Neuro-Marketing Service starting...")
    shared_path = Path(settings.shared_volume_path)
    if not shared_path.exists():
        logger.warning(f"Shared volume path does not exist: {shared_path}")
    else:
        logger.info(f"Shared volume path is ready: {shared_path}")


@app.post(
    "/api/v1/neuro-marketing/experiments/{experiment_id}/analyze",
    response_model=AnalysisResponse,
    summary="指定された実験の脳波データを解析し、推奨事項を生成します。",
)
async def analyze_experiment(
    experiment_id: UUID,
    # 権限チェックをDI (Dependency Injection) を使用して実行
    authorized: bool = Depends(verify_owner_role),
    x_user_id: str = Header(..., alias="X-User-Id"),
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
        raise HTTPException(
            status_code=403, detail="Forbidden: User is not the owner of this experiment."
        )

    logger.info(f"Analysis requested for experiment_id: {experiment_id}")

    try:
        recommendations, summary = await run_full_analysis(experiment_id)

        analysis_response = AnalysisResponse(
            experiment_id=experiment_id,
            summary=summary,
            recommendations=recommendations,
        )

        try:
            save_analysis_result(analysis_response, x_user_id)
        except Exception as db_error:
            logger.error(
                "Failed to save analysis result for experiment %s: %s. "
                "Returning response without persistence.",
                experiment_id,
                db_error,
                exc_info=True,
            )

        return analysis_response
    except HTTPException as http_exc:
        # サービス間通信やデータ不足のエラーをクライアントに転送
        logger.error(f"HTTP exception during analysis for {experiment_id}: {http_exc.detail}")
        raise http_exc
    except Exception as e:
        # 予期せぬ内部エラー
        logger.exception(
            "An unexpected error occurred during analysis for experiment_id: %s",
            experiment_id,
        )
        raise HTTPException(
            status_code=500,
            detail=f"An internal error occurred: {str(e)}",
        ) from e


@app.get(
    "/api/v1/neuro-marketing/experiments/{experiment_id}/analysis-results",
    response_model=AnalysisResultSnapshot,
    summary="最新のニューロマーケティング分析結果を取得します。",
)
async def get_analysis_result(
    experiment_id: UUID,
    authorized: bool = Depends(verify_owner_role),
    x_user_id: str = Header(..., alias="X-User-Id"),
):
    if not authorized:
        raise HTTPException(
            status_code=403, detail="Forbidden: User is not the owner of this experiment."
        )

    logger.info(
        "Latest analysis result requested for experiment %s by %s", experiment_id, x_user_id
    )

    record = get_latest_analysis_result(experiment_id)
    if not record:
        raise HTTPException(
            status_code=404, detail="No completed analysis result found for this experiment."
        )

    try:
        recommendations = [ProductRecommendation(**rec) for rec in record["recommendations"]]
    except (ValidationError, TypeError, ValueError, KeyError) as validation_error:
        logger.error(
            "Failed to deserialize stored analysis result for experiment %s (analysis_id=%s)",
            experiment_id,
            record["analysis_id"],
            exc_info=True,
        )
        raise HTTPException(
            status_code=500,
            detail=(
                "The stored analysis result is corrupted. Please re-run the analysis or "
                "contact support."
            ),
        ) from validation_error

    return AnalysisResultSnapshot(
        analysis_id=record["analysis_id"],
        experiment_id=record["experiment_id"],
        summary=record["summary"],
        recommendations=recommendations,
        generated_at=record["generated_at"],
        requested_by_user_id=record["requested_by_user_id"],
    )
