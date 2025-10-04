import asyncio
import logging
from pathlib import Path
from typing import List, Tuple
from uuid import UUID

import pandas as pd
from fastapi import HTTPException

from ...config.env import settings
from ...infrastructure.bids_client import BidsCreationError, request_bids_creation
from ...infrastructure.db import get_db_connection, get_db_cursor
from .preprocess import create_epochs_from_bids
from .models import ErpDetector, EmoSpecEstimator

# --- ロガー設定 ---
logger = logging.getLogger(__name__)

MAIN_SESSION_TYPES = {'main', 'main_integrated', 'main_external'}


async def _load_experiment_metadata(experiment_id: UUID) -> Tuple[pd.DataFrame, pd.DataFrame]:
    """Fetch sessions and stimuli metadata from the database in a background thread."""

    def _query() -> Tuple[pd.DataFrame, pd.DataFrame]:
        with get_db_connection() as conn:
            with get_db_cursor(conn) as cur:
                cur.execute(
                    """
                    SELECT session_id,
                           user_id,
                           session_type,
                           start_time
                    FROM sessions
                    WHERE experiment_id = %s
                      AND event_correction_status = 'completed'
                    ORDER BY start_time ASC
                    """,
                    (str(experiment_id),),
                )
                sessions_rows = cur.fetchall()

                cur.execute(
                    """
                    SELECT stimulus_id,
                           file_name,
                           trial_type,
                           item_name,
                           brand_name
                    FROM experiment_stimuli
                    WHERE experiment_id = %s
                    """,
                    (str(experiment_id),),
                )
                stimuli_rows = cur.fetchall()

        session_columns = ['session_id', 'user_id', 'session_type', 'start_time']
        sessions_df = (
            pd.DataFrame(sessions_rows, columns=session_columns)
            if sessions_rows
            else pd.DataFrame(columns=session_columns)
        )
        stimuli_columns = ['stimulus_id', 'file_name', 'trial_type', 'item_name', 'brand_name']
        stimuli_df = (
            pd.DataFrame(stimuli_rows, columns=stimuli_columns)
            if stimuli_rows
            else pd.DataFrame(columns=stimuli_columns)
        )

        if not sessions_df.empty and 'start_time' in sessions_df.columns:
            sessions_df = sessions_df.sort_values('start_time').reset_index(drop=True)
            sessions_df['session_index'] = range(1, len(sessions_df) + 1)

        return sessions_df, stimuli_df

    return await asyncio.to_thread(_query)

async def run_full_analysis(
    experiment_id: UUID,
) -> tuple[list[dict], str]:
    """
    脳波解析の全プロセスを調整・実行する。

    :param experiment_id: 解析対象の実験ID
    :return: (推奨アイテムのリスト, 解析サマリー)
    """
    logger.info(f"Starting full analysis for experiment: {experiment_id}")

    sessions_df, stimuli_df = await _load_experiment_metadata(experiment_id)

    if sessions_df.empty:
        raise HTTPException(status_code=404, detail="No completed sessions found for this experiment.")

    sessions_df['session_type_clean'] = (
        sessions_df['session_type']
        .fillna('')
        .astype(str)
        .str.strip()
        .str.lower()
    )

    cal_sessions_df = sessions_df[sessions_df['session_type_clean'] == 'calibration'].copy()
    main_sessions_df = sessions_df[
        sessions_df['session_type_clean'].isin(MAIN_SESSION_TYPES)
    ].copy()

    if cal_sessions_df.empty:
        raise HTTPException(
            status_code=404,
            detail="No completed calibration sessions found for this experiment.",
        )

    if main_sessions_df.empty:
        raise HTTPException(
            status_code=404,
            detail="No completed main task sessions found for this experiment.",
        )

    if stimuli_df.empty:
        raise HTTPException(status_code=404, detail="No stimuli (products) found for this experiment.")

    # 2. BIDS Exporterにデータセット生成を依頼
    try:
        bids_response = await request_bids_creation(experiment_id)
        bids_root_path_str = bids_response['bids_path']
    except BidsCreationError as e:
        logger.error(f"Failed to create BIDS dataset for experiment {experiment_id}: {e}")
        raise HTTPException(status_code=503, detail=str(e))

    bids_root_path = Path(bids_root_path_str)
    
    if not bids_root_path.exists():
        raise HTTPException(status_code=500, detail=f"BIDS dataset path not found on shared volume: {bids_root_path_str}")

    logger.info(f"BIDS dataset is ready at: {bids_root_path}")

    # 3. BIDSデータからEpochsオブジェクトを生成
    # calibration_epochs
    cal_epochs = create_epochs_from_bids(
        bids_root_path=bids_root_path,
        sessions_df=cal_sessions_df,
        default_task='calibration',
    )

    # main_epochs
    main_epochs = create_epochs_from_bids(
        bids_root_path=bids_root_path,
        sessions_df=main_sessions_df,
        default_task='main',
    )
    if cal_epochs is None or len(cal_epochs) == 0:
        raise HTTPException(status_code=404, detail="Could not create epochs from calibration BIDS data. Check if data exists.")
    if main_epochs is None or len(main_epochs) == 0:
        raise HTTPException(status_code=404, detail="Could not create epochs from main task BIDS data. Check if data exists.")

    logger.info(f"Created {len(cal_epochs)} calibration epochs and {len(main_epochs)} main epochs.")

    # 4. モデルの学習と推論
    model_dir = Path(settings.shared_volume_path) / "models" / str(experiment_id)
    erp_detector = ErpDetector(cal_epochs, save_path=str(model_dir))

    emo_estimator = EmoSpecEstimator(erp_detector.clf, main_epochs)
    
    # 5. 結果の集計と整形
    predictions = emo_estimator.result

    if main_epochs.metadata is None:
        raise HTTPException(
            status_code=500,
            detail="Epoch metadata is missing for main task sessions.",
        )

    main_epochs_df = main_epochs.metadata.copy()
    main_epochs_df['prediction'] = predictions

    # 'target' に分類されたイベントに対応する刺激情報を取得
    # 'target' の event_id を特定する必要がある (ここでは 'target' -> 1 と仮定)
    # event_id_map は preprocess.py 内で動的に作られるため、ここでは文字列で比較
    detected_events = main_epochs_df[main_epochs_df['prediction'] == 1]

    recommendations: List[dict] = []
    if not detected_events.empty:
        detected_files_series = (
            detected_events['stim_file']
            .astype(str)
            .str.split('/')
            .str[-1]
            .str.strip()
        )
        detected_files = [name for name in detected_files_series.unique() if name and name != 'n/a']

        if detected_files:
            recommended_df = stimuli_df[stimuli_df['file_name'].isin(detected_files)]
            recommendations = recommended_df[['file_name', 'item_name', 'brand_name']].to_dict('records')

    # 簡単なサマリーを生成
    summary = (
        f"解析が完了しました。{len(cal_epochs)}件のキャリブレーションデータからモデルを学習し、"
        f"{len(main_epochs)}件の計測データから解析しました。"
        f"結果、{len(recommendations)}件の関心が高い可能性のあるアイテムが見つかりました。"
    )
    logger.info(f"Analysis complete. Found {len(recommendations)} recommendations.")
    
    return recommendations, summary
