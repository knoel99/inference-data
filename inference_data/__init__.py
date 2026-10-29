"""Load the inference-data tables as pandas DataFrames.

The default base is the raw file on the ``main`` branch. Set
``INFERENCE_DATA_BASE`` or pass ``base`` to read a local ``data/`` directory
or another URL prefix.
"""

from __future__ import annotations

import os
from pathlib import Path

__all__ = ["load", "RAW_BASE"]

RAW_BASE = "https://raw.githubusercontent.com/knoel99/inference-data/main/data"
TABLES = ("hardware", "models", "sources", "measurements", "agentic")


def load(base: str | None = None, joined: bool = True):
    """Return a measurements frame left-joined to hardware, models, and sources.

    Pass ``joined=False`` to get a dict of all tables instead, including
    ``agentic`` (agentic-trace results with prefix-cache hit rates).
    """
    import pandas as pd

    root = base or os.environ.get("INFERENCE_DATA_BASE") or RAW_BASE
    frames = {name: _read(root, name, pd) for name in TABLES}
    if not joined:
        return frames
    hardware = _prefix(frames["hardware"], "hw_", keep={"hardware_id"})
    models = _prefix(frames["models"], "model_", keep={"model_id"})
    sources = _prefix(frames["sources"], "source_", keep={"source_id"})
    out = frames["measurements"].merge(hardware, on="hardware_id", how="left")
    out = out.merge(models, on="model_id", how="left")
    out = out.merge(sources, on="source_id", how="left")
    return out


def _read(root: str, name: str, pd):
    filename = f"{name}.csv"
    if root.startswith("http://") or root.startswith("https://"):
        return pd.read_csv(root.rstrip("/") + "/" + filename)
    return pd.read_csv(Path(root) / filename)


def _prefix(frame, prefix: str, keep: set[str]):
    rename = {col: prefix + col for col in frame.columns if col not in keep}
    return frame.rename(columns=rename)
