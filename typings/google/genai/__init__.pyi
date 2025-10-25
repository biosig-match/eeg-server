from typing import Any

from . import types

__all__ = ["Client", "types"]

class Client:
    def __init__(self, *args: Any, **kwargs: Any) -> None: ...
    class models:
        @staticmethod
        def generate_content(*args: Any, **kwargs: Any) -> Any: ...
