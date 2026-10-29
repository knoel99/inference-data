#!/usr/bin/env python3
"""Write Parquet copies of the CSV tables. Requires pandas and pyarrow."""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
TABLES = ("sources", "hardware", "models", "measurements")


def main() -> int:
    dest = Path(sys.argv[1] if len(sys.argv) > 1 else "dist/parquet")
    dest.mkdir(parents=True, exist_ok=True)
    for name in TABLES:
        frame = pd.read_csv(ROOT / "data" / f"{name}.csv")
        path = dest / f"{name}.parquet"
        frame.to_parquet(path, index=False)
        print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
