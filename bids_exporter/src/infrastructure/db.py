from contextlib import contextmanager

import psycopg2
from psycopg2.extras import DictCursor

from ..config.env import settings

@contextmanager
def get_db_connection():
    conn = psycopg2.connect(settings.database_url)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

@contextmanager
def get_db_cursor(conn):
    cur = conn.cursor(cursor_factory=DictCursor)
    try:
        yield cur
    finally:
        cur.close()
