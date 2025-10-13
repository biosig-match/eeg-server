from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict, Optional

import numpy as np

from ..state import UserState

AnalysisResult = Dict[str, Any]


class RealtimeApplication(ABC):
    """Base class for realtime analysis applications."""

    app_id: str
    display_name: str
    description: str

    def on_registered(self) -> None:
        """Hook invoked when the application is registered with the host."""

    def before_analysis_cycle(self) -> None:
        """Hook executed before each host analysis cycle."""

    def after_analysis_cycle(self) -> None:
        """Hook executed after each host analysis cycle."""

    def on_profile_initialized(self, user_id: str, state: UserState) -> None:
        """Hook invoked when a new device profile is created."""

    @abstractmethod
    def analyze(
        self,
        user_id: str,
        state: UserState,
        window: np.ndarray,
    ) -> Optional[AnalysisResult]:
        """Run application-specific analysis and return serialisable results."""

    # Provide empty defaults so subclasses only override what they need.
    def on_registered(self) -> None:  # type: ignore[override]
        pass

    def before_analysis_cycle(self) -> None:  # type: ignore[override]
        pass

    def after_analysis_cycle(self) -> None:  # type: ignore[override]
        pass

    def on_profile_initialized(self, user_id: str, state: UserState) -> None:  # type: ignore[override]
        pass
