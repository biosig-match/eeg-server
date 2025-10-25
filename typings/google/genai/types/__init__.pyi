
from typing import Any

class Part:
    @staticmethod
    def from_text(*args: Any, **kwargs: Any) -> Part: ...
    @staticmethod
    def from_bytes(*args: Any, **kwargs: Any) -> Part: ...
