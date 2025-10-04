from contextlib import contextmanager

import psycopg2
from psycopg2.extras import DictCursor

from ..config.env import settings

@contextmanager
def get_db_connection():
    conn = psycopg2.connect(settings.database_url)
    try:
        yield conn
    finally:
        conn.close()

def get_db_cursor(conn):
    return conn.cursor(cursor_factory=DictCursor)
