import os
import logging
from pathlib import Path
from uuid import UUID
import pandas as pd
from fastapi import HTTPException
import mne

from src.bids_client import request_bids_creation, BidsCreationError
from src.db import get_db_connection
from src.analysis.preprocess import create_epochs_from_bids
from src.analysis.models import ErpDetector, EmoSpecEstimator

# --- ロガー設定 ---
logger = logging.getLogger(__name__)

async def get_session_info(conn, experiment_id: UUID, session_type: str) -> pd.DataFrame:
    """指定された実験とセッションタイプのセッション情報をDBから取得する"""
    query = """
    SELECT session_id, user_id FROM sessions
    WHERE experiment_id = $1 AND session_type = $2 AND event_correction_status = 'completed'
    """
    rows = await conn.fetch(query, experiment_id, session_type)
    return pd.DataFrame(rows, columns=['session_id', 'user_id'])

async def get_stimuli_info(conn, experiment_id: UUID) -> pd.DataFrame:
    """指定された実験の刺激（商品）情報をDBから取得する"""
    query = "SELECT stimulus_id, file_name, trial_type, item_name, brand_name FROM experiment_stimuli WHERE experiment_id = $1"
    rows = await conn.fetch(query, experiment_id)
    return pd.DataFrame(rows, columns=['stimulus_id', 'file_name', 'trial_type', 'item_name', 'brand_name'])

async def run_full_analysis(
    experiment_id: UUID,
    bids_exporter_url: str,
    shared_volume_path: str,
) -> tuple[list[dict], str]:
    """
    脳波解析の全プロセスを調整・実行する。

    :param experiment_id: 解析対象の実験ID
    :param bids_exporter_url: BIDS ExporterサービスのエンドポイントURL
    :param shared_volume_path: 共有ボリュームのパス
    :return: (推奨アイテムのリスト, 解析サマリー)
    """
    logger.info(f"Starting full analysis for experiment: {experiment_id}")

    # 1. DBからセッションと刺激の情報を取得
    async with get_db_connection() as conn:
        main_sessions_df = await get_session_info(conn, experiment_id, "main")
        cal_sessions_df = await get_session_info(conn, experiment_id, "calibration")

        if cal_sessions_df.empty:
            raise HTTPException(status_code=404, detail="No completed calibration sessions found for this experiment.")
        if main_sessions_df.empty:
            raise HTTPException(status_code=404, detail="No completed main task sessions found for this experiment.")
        
        stimuli_df = await get_stimuli_info(conn, experiment_id)
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
        task='calibration'
    )

    # main_epochs
    main_epochs = create_epochs_from_bids(
        bids_root_path=bids_root_path,
        sessions_df=main_sessions_df,
        task='main'
    )
    if cal_epochs is None or len(cal_epochs) == 0:
        raise HTTPException(status_code=404, detail="Could not create epochs from calibration BIDS data. Check if data exists.")
    if main_epochs is None or len(main_epochs) == 0:
        raise HTTPException(status_code=404, detail="Could not create epochs from main task BIDS data. Check if data exists.")

    logger.info(f"Created {len(cal_epochs)} calibration epochs and {len(main_epochs)} main epochs.")

    # 4. モデルの学習と推論
    model_dir = Path(shared_volume_path) / "models" / str(experiment_id)
    erp_detector = ErpDetector(cal_epochs, save_path=str(model_dir))

    emo_estimator = EmoSpecEstimator(erp_detector.clf, main_epochs)
    
    # 5. 結果の集計と整形
    predictions = emo_estimator.result
    main_epochs_df = main_epochs.metadata.copy()
    main_epochs_df['prediction'] = predictions

    # 'target' に分類されたイベントに対応する刺激情報を取得
    # 'target' の event_id を特定する必要がある (ここでは 'target' -> 1 と仮定)
    # event_id_map は preprocess.py 内で動的に作られるため、ここでは文字列で比較
    detected_events = main_epochs_df[main_epochs_df['prediction'] == 1]

    recommendations = []
    if not detected_events.empty:
        # stim_fileカラムからファイル名だけを抽出 (例: 'stimuli/product_A.jpg' -> 'product_A.jpg')
        detected_files = detected_events['stim_file'].str.split('/').str[-1].unique()
        
        # 検出されたファイル名に一致する刺激情報をstimuli_dfから取得
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
