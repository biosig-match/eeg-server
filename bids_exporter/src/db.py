import os
import psycopg2
from psycopg2.extras import DictCursor
from contextlib import contextmanager

DATABASE_URL = os.getenv("DATABASE_URL")

@contextmanager
def get_db_connection():
    conn = psycopg2.connect(DATABASE_URL)
    try:
        yield conn
    finally:
        conn.close()

def get_db_cursor(conn):
    return conn.cursor(cursor_factory=DictCursor)
