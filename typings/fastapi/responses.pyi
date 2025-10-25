from collections.abc import Iterable, Mapping
from typing import Any

class StreamingResponse:
    def __init__(
        self,
        content: Iterable[Any] | Any,
        *,
        media_type: str | None = ...,
        headers: Mapping[str, str] | None = ...,
    ) -> None: ...

class JSONResponse:
    def __init__(self, content: Any, status_code: int = ...) -> None: ...
