#!/usr/bin/env python3
"""Assemble the GitHub Pages site into _site/ (or the given directory).

The page in site/ reads the same CSV tables and datapackage.json as every
other consumer, so they are copied next to it rather than duplicated in git.
Standard library only.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COPY = ("datapackage.json", "llms.txt")


def main() -> int:
    dest = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "_site")
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(ROOT / "site", dest)
    shutil.copytree(ROOT / "data", dest / "data")
    for name in COPY:
        shutil.copy2(ROOT / name, dest / name)
    (dest / ".nojekyll").touch()
    print(dest)
    return 0


if __name__ == "__main__":
    sys.exit(main())
