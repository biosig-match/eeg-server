import asyncio
import logging
import mimetypes
from pathlib import Path
from typing import Any, cast
from uuid import UUID

import pandas as pd
from fastapi import HTTPException

from ...config.env import settings
from ...infrastructure.bids_client import BidsCreationError, request_bids_creation
from ...infrastructure.db import get_db_connection, get_db_cursor
from .models import EmoSpecEstimator, ErpDetector
from .preprocess import create_epochs_from_bids

try:
    from google import genai  # type: ignore[import]
    from google.genai import types  # type: ignore[import]
except ImportError:  # pragma: no cover - optional dependency guard
    genai = None  # type: ignore[assignment]
    types = None  # type: ignore[assignment]

genai = cast(Any, genai)
types = cast(Any, types)

# --- ロガー設定 ---
logger = logging.getLogger(__name__)

MAIN_SESSION_TYPES = {"main", "main_integrated", "main_external", "main_task"}


async def generate_ai_summary(recommendations: list[dict]) -> str:
    if not recommendations:
        return (
            "ユーザーが高い関心を示した特定の製品は見つかりませんでした。"
            "キャリブレーションデータや計測条件をご確認ください。"
        )

    try:
        if not settings.gemini_api_key or genai is None or types is None:
            logger.warning("GEMINI_API_KEY is not set. Returning a default summary.")
            return f"解析の結果、{len(recommendations)}件の製品に高い関心が示されました。"

        # 1. プロンプトの準備
        product_descriptions = [
            " ".join(
                filter(
                    None,
                    [item.get("brand_name"), item.get("item_name"), f"({item.get('file_name')})"],
                )
            )
            for item in recommendations
        ]
        products_text = ", ".join(product_descriptions)

        system_prompt = (
            "あなたは経験豊富なニューロマーケティングのアナリストです。"
            "提供された、消費者が脳波レベルで高い関心を示した商品のリストを基に、"
            "その消費者の潜在的な好みや関心事について、簡潔かつ説得力のあるサマリーを1つの段落で作成してください。"
            "プロフェッショナルでありながら、分かりやすい言葉で記述してください。"
        )
        user_prompt = f"高い関心が示された商品は以下の通りです: {products_text}"

        # 2. 同期処理の関数を定義
        assert genai is not None and types is not None
        genai_client = cast(Any, genai)
        types_module = cast(Any, types)

        def _generate():
            client = genai_client.Client(api_key=settings.gemini_api_key)
            prompt = f"{system_prompt}\n\n{user_prompt}"
            contents = [types_module.Part.from_text(text=prompt)]
            max_images = 10
            attached_images = 0
            for item in recommendations:
                if attached_images >= max_images:
                    break
                image_path = item.get("image_path")
                if not image_path:
                    continue
                try:
                    image_data = Path(image_path).read_bytes()
                    mime_type, _ = mimetypes.guess_type(image_path)
                    mime_type = mime_type or "image/png"
                    contents.append(
                        types_module.Part.from_bytes(data=image_data, mime_type=mime_type)
                    )
                    attached_images += 1
                except Exception as exc:
                    logger.warning(
                        "Failed to attach image '%s' for Gemini summary: %s",
                        image_path,
                        exc,
                    )
            response = client.models.generate_content(
                model="models/gemini-2.5-flash",
                contents=contents,
            )
            return response.text or ""

        # 3. 同期関数をバックグラウンドスレッドで実行（タイムアウト・リトライ付き）
        timeout_seconds = getattr(settings, "gemini_timeout_seconds", 30.0)
        max_retries = 3
        backoff_seconds = 2.0
        fallback_summary = f"解析の結果、{len(recommendations)}件の製品に高い関心が示されました。"

        for attempt in range(1, max_retries + 1):
            try:
                summary = await asyncio.wait_for(
                    asyncio.to_thread(_generate),
                    timeout=timeout_seconds,
                )
                return summary.strip() or fallback_summary
            except TimeoutError:
                logger.error(
                    "Gemini API call timed out after %.1f seconds (attempt %d/%d)",
                    timeout_seconds,
                    attempt,
                    max_retries,
                )
            except Exception as api_error:  # pragma: no cover - defensive logging
                status_code = getattr(api_error, "status_code", None)
                error_text = str(api_error)
                if status_code == 429 or "429" in error_text:
                    logger.warning(
                        "Gemini API rate limit encountered (attempt %d/%d): %s",
                        attempt,
                        max_retries,
                        api_error,
                    )
                else:
                    logger.error(
                        "Gemini API call failed (attempt %d/%d): %s",
                        attempt,
                        max_retries,
                        api_error,
                        exc_info=True,
                    )
            if attempt < max_retries:
                await asyncio.sleep(backoff_seconds)
                backoff_seconds = min(backoff_seconds * 2, 10.0)
        return f"{fallback_summary}(AIサマリーの生成に失敗しました)"

    except Exception:
        logger.exception("An unexpected error occurred during AI summary generation")
        return (
            f"解析の結果、{len(recommendations)}件の製品に高い関心が示されました。"
            "(AIサマリーの生成中にエラー発生)"
        )


async def _load_experiment_metadata(experiment_id: UUID) -> tuple[pd.DataFrame, pd.DataFrame]:
    def _query() -> tuple[pd.DataFrame, pd.DataFrame]:
        with get_db_connection() as conn:
            with get_db_cursor(conn) as cur:
                cur.execute(
                    """
                    SELECT DISTINCT ON (s.session_id)
                           s.session_id,
                           s.user_id,
                           s.session_type,
                           s.start_time
                    FROM sessions s
                    JOIN session_events se ON s.session_id = se.session_id
                    WHERE s.experiment_id = %s
                      AND s.event_correction_status = 'completed'
                    ORDER BY s.session_id, s.start_time ASC
                    """,
                    (str(experiment_id),),
                )
                sessions_rows = cur.fetchall()

                cur.execute(
                    """
                    SELECT stimulus_id, file_name, trial_type, item_name, brand_name,
                           description, category, gender
                    FROM experiment_stimuli
                    WHERE experiment_id = %s
                    """,
                    (str(experiment_id),),
                )
                stimuli_rows = cur.fetchall()

        session_columns = ["session_id", "user_id", "session_type", "start_time"]
        sessions_df = (
            pd.DataFrame(sessions_rows, columns=session_columns)
            if sessions_rows
            else pd.DataFrame(columns=session_columns)
        )
        stimuli_columns = [
            "stimulus_id",
            "file_name",
            "trial_type",
            "item_name",
            "brand_name",
            "description",
            "category",
            "gender",
        ]
        stimuli_df = (
            pd.DataFrame(stimuli_rows, columns=stimuli_columns)
            if stimuli_rows
            else pd.DataFrame(columns=stimuli_columns)
        )

        if not sessions_df.empty and "start_time" in sessions_df.columns:
            sessions_df = sessions_df.sort_values("start_time").reset_index(drop=True)
            sessions_df["session_index"] = range(1, len(sessions_df) + 1)

        return sessions_df, stimuli_df

    return await asyncio.to_thread(_query)


async def run_full_analysis(
    experiment_id: UUID,
) -> tuple[list[dict], str]:
    logger.info(f"Starting full analysis for experiment: {experiment_id}")

    sessions_df, stimuli_df = await _load_experiment_metadata(experiment_id)

    if sessions_df.empty:
        raise HTTPException(
            status_code=404,
            detail="No completed sessions with valid events found for this experiment.",
        )

    sessions_df["session_type_clean"] = (
        sessions_df["session_type"].fillna("").astype(str).str.strip().str.lower()
    )

    cal_sessions_df = sessions_df[sessions_df["session_type_clean"] == "calibration"].copy()
    main_sessions_df = sessions_df[
        sessions_df["session_type_clean"].isin(MAIN_SESSION_TYPES)
    ].copy()

    if cal_sessions_df.empty:
        raise HTTPException(
            status_code=404,
            detail="No completed calibration sessions with valid events found.",
        )

    if main_sessions_df.empty:
        raise HTTPException(
            status_code=404,
            detail="No completed main task sessions with valid events found.",
        )

    if stimuli_df.empty:
        raise HTTPException(
            status_code=404, detail="No stimuli (products) found for this experiment."
        )

    try:
        bids_response = await request_bids_creation(experiment_id)
        bids_root_path_str = bids_response["bids_path"]
    except BidsCreationError as e:
        logger.error(
            "Failed to create BIDS dataset for experiment %s: %s",
            experiment_id,
            e,
        )
        raise HTTPException(status_code=503, detail=str(e)) from e

    bids_root_path = Path(bids_root_path_str)

    if not bids_root_path.exists():
        raise HTTPException(
            status_code=500,
            detail=f"BIDS dataset path not found on shared volume: {bids_root_path_str}",
        )

    logger.info(f"BIDS dataset is ready at: {bids_root_path}")

    cal_epochs = create_epochs_from_bids(
        bids_root_path=bids_root_path,
        sessions_df=cal_sessions_df,
        default_task="calibration",
    )
    main_epochs = create_epochs_from_bids(
        bids_root_path=bids_root_path,
        sessions_df=main_sessions_df,
        default_task="main",
    )
    if cal_epochs is None or len(cal_epochs) == 0:
        raise HTTPException(
            status_code=404,
            detail=(
                "Could not create epochs from calibration BIDS data. "
                "Check if event data exists and is correctly formatted."
            ),
        )
    if main_epochs is None or len(main_epochs) == 0:
        raise HTTPException(
            status_code=404,
            detail=(
                "Could not create epochs from main task BIDS data. "
                "Check if event data exists and is correctly formatted."
            ),
        )

    logger.info(
        "Created %d calibration epochs and %d main epochs.",
        len(cal_epochs),
        len(main_epochs),
    )

    model_dir = Path(settings.shared_volume_path) / "models" / str(experiment_id)
    erp_detector = ErpDetector(cal_epochs, save_path=str(model_dir))
    emo_estimator = EmoSpecEstimator(erp_detector.clf, main_epochs)

    predictions = emo_estimator.result
    if main_epochs.metadata is None:
        raise HTTPException(
            status_code=500, detail="Epoch metadata is missing for main task sessions."
        )

    main_epochs_df = main_epochs.metadata.copy()
    main_epochs_df["prediction"] = predictions

    detected_events = main_epochs_df[main_epochs_df["prediction"] == 1]

    recommendations: list[dict] = []
    if not detected_events.empty:
        detected_files_series = (
            detected_events["stim_file"].astype(str).str.split("/").str[-1].str.strip()
        )
        detected_files = [name for name in detected_files_series.unique() if name and name != "n/a"]

        if detected_files:
            recommended_df = stimuli_df[stimuli_df["file_name"].isin(detected_files)]
            recommendations = recommended_df.to_dict("records")

            recommendations_for_summary: list[dict] = []
            for record in recommendations:
                enriched = record.copy()
                file_name = record.get("file_name")
                if file_name:
                    image_path = bids_root_path / "stimuli" / file_name
                    if image_path.exists():
                        enriched["image_path"] = str(image_path)
                    else:
                        logger.warning(
                            "Stimulus image '%s' referenced in recommendations was not found at %s",
                            file_name,
                            image_path,
                        )
                recommendations_for_summary.append(enriched)
        else:
            recommendations_for_summary = []
    else:
        recommendations_for_summary = []

    summary = await generate_ai_summary(recommendations_for_summary)

    logger.info(f"Analysis complete. Found {len(recommendations)} recommendations.")

    return recommendations, summary
