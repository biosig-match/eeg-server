from __future__ import annotations

import importlib
import inspect
import pkgutil
from collections.abc import Iterable, Iterator, Sequence
from pathlib import Path

from .base import AnalysisResult, RealtimeApplication

ApplicationSource = (
    RealtimeApplication
    | type[RealtimeApplication]
    | Iterable[RealtimeApplication]
    | None
)

__all__ = ["AnalysisResult", "RealtimeApplication", "discover_applications"]


def discover_applications() -> list[RealtimeApplication]:
    """Instantiate all realtime applications packaged under this module."""
    package_dir = Path(__file__).parent
    package_name = __name__
    discovered: list[RealtimeApplication] = []
    seen_ids: set[str] = set()

    for module_info in pkgutil.iter_modules([str(package_dir)]):
        if module_info.name.startswith("_") or not module_info.ispkg:
            continue

        module = importlib.import_module(f"{package_name}.{module_info.name}")
        for application in _instantiate_from_module(module):
            if application.app_id in seen_ids:
                raise ValueError(
                    f"Duplicate realtime application id detected: {application.app_id}"
                )
            seen_ids.add(application.app_id)
            discovered.append(application)

    return discovered


def _instantiate_from_module(module) -> Iterator[RealtimeApplication]:
    """Yield application instances exposed by a module or package."""
    yield from _normalise_instances(_invoke_factory(module, "create_applications"))
    yield from _normalise_instances(_invoke_factory(module, "create_application"))

    candidate_names: Sequence[str]
    if hasattr(module, "__all__"):
        candidate_names = tuple(module.__all__)  # type: ignore[assignment]
    else:
        candidate_names = tuple(name for name in dir(module) if not name.startswith("_"))

    seen_classes: set[type[RealtimeApplication]] = set()
    for name in candidate_names:
        attr = getattr(module, name, None)
        if not inspect.isclass(attr):
            continue
        if not issubclass(attr, RealtimeApplication) or attr is RealtimeApplication:
            continue
        if attr in seen_classes:
            continue
        seen_classes.add(attr)
        yield attr()


def _invoke_factory(module, attribute: str) -> Iterable[ApplicationSource]:
    factory = getattr(module, attribute, None)
    if factory is None:
        return ()
    result = factory()
    if result is None:
        return ()
    return result  # type: ignore[return-value]


def _normalise_instances(value: ApplicationSource | Iterable[ApplicationSource]) -> Iterator[
    RealtimeApplication
]:
    if value is None:
        return iter(())

    if isinstance(value, RealtimeApplication):
        return iter((value,))

    if inspect.isclass(value) and issubclass(value, RealtimeApplication):
        return iter((value(),))

    if isinstance(value, Iterable):
        instances: list[RealtimeApplication] = []
        for item in value:
            if item is None:
                continue
            if isinstance(item, RealtimeApplication):
                instances.append(item)
            elif inspect.isclass(item) and issubclass(item, RealtimeApplication):
                instances.append(item())
            else:
                raise TypeError(f"Unsupported realtime application entry: {item!r}")
        return iter(instances)

    raise TypeError(f"Unsupported realtime application entry: {value!r}")
