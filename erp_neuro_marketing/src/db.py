import os
import psycopg2
from psycopg2.extras import DictCursor
from contextlib import contextmanager
from typing import List
from uuid import UUID

from src.schemas import ProductRecommendation

DATABASE_URL = os.getenv("DATABASE_URL")

@contextmanager
def get_db_connection():
    """Provides a transactional database connection."""
    try:
        conn = psycopg2.connect(DATABASE_URL)
        yield conn
    finally:
        if conn:
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
