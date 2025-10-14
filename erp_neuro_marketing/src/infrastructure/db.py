from contextlib import contextmanager
import json
from datetime import datetime
from typing import List, Optional
from uuid import UUID

import psycopg2
from psycopg2.extras import DictCursor

from ..app.schemas import AnalysisResponse, ProductRecommendation
from ..config.env import settings

@contextmanager
def get_db_connection():
    """Provides a transactional database connection."""
    conn = psycopg2.connect(settings.database_url)
    try:
        yield conn
    finally:
        conn.close()

def get_db_cursor(conn):
    """Returns a dictionary cursor."""
    return conn.cursor(cursor_factory=DictCursor)

def get_product_details_from_db(conn, experiment_id: UUID, file_names: List[str]) -> List[ProductRecommendation]:
    """
    Fetches detailed information for a list of stimulus file names within an experiment.
    """
    if not file_names:
        return []
        
    with get_db_cursor(conn) as cur:
        query = """
            SELECT file_name, item_name, brand_name, description, category, gender
            FROM experiment_stimuli
            WHERE experiment_id = %s AND file_name = ANY(%s)
        """
        cur.execute(query, (str(experiment_id), file_names))
        rows = cur.fetchall()
        
        # Pydanticモデルに変換
        return [ProductRecommendation(**dict(row)) for row in rows]


def save_analysis_result(result: AnalysisResponse, requested_by_user_id: str) -> None:
    payload = {
        'summary': result.summary,
        'recommendations': [rec.dict() for rec in result.recommendations],
    }

    with get_db_connection() as conn:
        with get_db_cursor(conn) as cur:
            cur.execute(
                """
                INSERT INTO erp_analysis_results (experiment_id, requested_by_user_id, status, result_data, completed_at)
                VALUES (%s, %s, %s, %s, NOW())
                """,
                (str(result.experiment_id), requested_by_user_id, 'completed', json.dumps(payload)),
            )
        conn.commit()


def get_latest_analysis_result(experiment_id: UUID) -> Optional[dict]:
    with get_db_connection() as conn:
        with get_db_cursor(conn) as cur:
            cur.execute(
                """
                SELECT analysis_id,
                       experiment_id,
                       requested_by_user_id,
                       result_data,
                       completed_at,
                       created_at
                FROM erp_analysis_results
                WHERE experiment_id = %s AND status = 'completed'
                ORDER BY completed_at DESC NULLS LAST, created_at DESC
                LIMIT 1
                """,
                (str(experiment_id),),
            )
            row = cur.fetchone()

            if not row:
                return None

            result_data = row['result_data'] or {}
            generated_at: Optional[datetime] = row['completed_at'] or row['created_at']

            return {
                'analysis_id': row['analysis_id'],
                'experiment_id': UUID(str(row['experiment_id'])),
                'requested_by_user_id': row['requested_by_user_id'],
                'summary': result_data.get('summary', ''),
                'recommendations': result_data.get('recommendations', []),
                'generated_at': generated_at,
            }
