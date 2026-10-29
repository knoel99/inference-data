#!/usr/bin/env python3
"""Run the README load path against the local data directory.

The one-liner in the README points at main. This script is the same loader
call with a filesystem base, so it runs before that branch is updated.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ["INFERENCE_DATA_BASE"] = str(ROOT / "data")

import pandas as pd

from inference_data import load


def main() -> None:
    measurements = pd.read_csv(ROOT / "data" / "measurements.csv")
    frame = load()
    if len(frame) != len(measurements):
        raise SystemExit("joined frame length does not match measurements.csv")
    if frame["source_url"].isna().any():
        raise SystemExit("a measurement is missing source_url after the join")
    if frame["evidence"].isna().any():
        raise SystemExit("a measurement is missing evidence")
    print(f"{len(frame)} measurements")
    print(frame.groupby("evidence").size().to_string())
    print("columns", ", ".join(frame.columns[:8]), "...")


if __name__ == "__main__":
    main()
