#!/usr/bin/env python3
"""Assemble the GitHub Pages site into _site/ (or the given directory).

The page in site/ reads the same CSV tables and datapackage.json as every
other consumer, so they are copied next to it rather than duplicated in git.
GitHub Pages lets browsers cache every file for ten minutes, so the page's
script and stylesheet links get a content hash: a new deploy can never pair a
fresh index.html with a stale app.js. Standard library only.
"""

from __future__ import annotations

import hashlib
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COPY = ("datapackage.json", "llms.txt")
VERSIONED = ("app.js", "style.css")


def main() -> int:
    dest = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "_site")
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(ROOT / "site", dest)
    page = dest / "index.html"
    html = page.read_text(encoding="utf-8")
    for name in VERSIONED:
        digest = hashlib.sha256((dest / name).read_bytes()).hexdigest()[:12]
        ref = f'"{name}"'
        if html.count(ref) != 1:
            raise SystemExit(f"index.html must reference {name} exactly once")
        html = html.replace(ref, f'"{name}?v={digest}"')
    page.write_text(html, encoding="utf-8")
    shutil.copytree(ROOT / "data", dest / "data")
    for name in COPY:
        shutil.copy2(ROOT / name, dest / name)
    (dest / ".nojekyll").touch()
    print(dest)
    return 0


if __name__ == "__main__":
    sys.exit(main())
