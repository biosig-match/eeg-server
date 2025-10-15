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

    @abstractmethod
    def analyze(
        self,
        user_id: str,
        state: UserState,
        window: np.ndarray,
    ) -> Optional[AnalysisResult]:
        """Run application-specific analysis and return serialisable results."""

    # Provide empty defaults so subclasses only override what they need.
    def on_registered(self) -> None:
        """Hook invoked when the application is registered with the host."""
        return None

    def before_analysis_cycle(self) -> None:
        """Hook executed before each host analysis cycle."""
        return None

    def after_analysis_cycle(self) -> None:
        """Hook executed after each host analysis cycle."""
        return None

    def on_profile_initialized(self, user_id: str, state: UserState) -> None:
        """Hook invoked when a new device profile is created."""
        return None
