from uuid import UUID

from ..infrastructure.db import get_db_connection, get_db_cursor
from ..app.schemas import TaskStatus

def create_task_in_db(task_id: UUID, experiment_id: UUID):
    """Creates the initial record for a new export task in the database."""
    with get_db_connection() as conn:
        with get_db_cursor(conn) as cur:
            cur.execute(
                """
                INSERT INTO export_tasks (task_id, experiment_id, status, progress)
                VALUES (%s, %s, 'pending', 0)
                """,
                (str(task_id), str(experiment_id))
            )

def get_task_status(task_id: UUID) -> TaskStatus | None:
    """Retrieves the current status of an export task from the database."""
    with get_db_connection() as conn:
        with get_db_cursor(conn) as cur:
            cur.execute("SELECT * FROM export_tasks WHERE task_id = %s", (str(task_id),))
            row = cur.fetchone()
            if row:
                return TaskStatus(**row)
    return None

def update_task_status(task_id: UUID, progress: int | None = None, status: str | None = None, status_message: str | None = None, result_path: str | None = None, error_message: str | None = None):
    """
    Updates the status, progress, and other details of an export task.
    This function is designed to be called multiple times during the export process.
    """
    with get_db_connection() as conn:
        with get_db_cursor(conn) as cur:
            # Build the SET part of the query dynamically
            set_clauses = ["updated_at = NOW()"]
            params = []
            
            if status is not None:
                set_clauses.append("status = %s")
                params.append(status)
            elif status_message is not None:
                set_clauses.append("status = %s")
                params.append('processing')

            if progress is not None:
                set_clauses.append("progress = %s")
                params.append(progress)
            
            if result_path is not None:
                set_clauses.append("result_file_path = %s")
                params.append(result_path)

            if error_message is not None:
                set_clauses.append("error_message = %s")
                params.append(error_message)

            if not set_clauses:
                return # Nothing to update
                
            query = f"UPDATE export_tasks SET {', '.join(set_clauses)} WHERE task_id = %s"
            params.append(str(task_id))
            
            cur.execute(query, tuple(params))
