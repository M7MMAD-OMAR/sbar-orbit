#!/usr/bin/env python3
"""Rewrite hardcoded /tmp temp roots in the test suite to tmpdir().

Measured on a Windows 11 guest: `bun test` there fails 121 of 248, and the single largest cause is
tests calling `mkdtemp("/tmp/orbit-...")` directly. `/tmp` does not exist on Windows, so the test
dies before it has exercised any Orbit code at all. That is a harness assumption, not a portability
finding about the product, and it hides the real findings underneath it.

This rewrites `mkdtemp("/tmp/x-")` to `mkdtemp(join(tmpdir(), "x-"))` and adds the imports each file
needs. `src/fedora.ts` is deliberately untouched: the private display is Linux only and its runtime
directory placement is a measured decision, not an accident.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CALL = re.compile(r'(mkdtempSync|mkdtemp)\("(/tmp/)([^"]+)"\)')


def ensure_import(text: str, names: list[str], module: str) -> str:
    """Add `names` to an existing import from `module`, or insert a new import line."""
    pattern = re.compile(r'^import \{([^}]*)\} from "' + re.escape(module) + r'";$', re.M)
    match = pattern.search(text)
    if match:
        existing = [part.strip() for part in match.group(1).split(",") if part.strip()]
        missing = [name for name in names if name not in existing]
        if not missing:
            return text
        merged = ", ".join(sorted(existing + missing))
        return text[: match.start()] + f'import {{ {merged} }} from "{module}";' + text[match.end() :]
    # No import from this module yet: put it after the last existing import line.
    lines = text.split("\n")
    last = max((index for index, line in enumerate(lines) if line.startswith("import ")), default=-1)
    lines.insert(last + 1, f'import {{ {", ".join(sorted(names))} }} from "{module}";')
    return "\n".join(lines)


def main() -> int:
    changed: list[tuple[str, int]] = []
    for path in sorted((ROOT / "tests").glob("*.test.ts")):
        text = path.read_text(encoding="utf-8")
        hits = CALL.findall(text)
        if not hits:
            continue
        text = CALL.sub(lambda m: f'{m.group(1)}(join(tmpdir(), "{m.group(3)}"))', text)
        text = ensure_import(text, ["tmpdir"], "node:os")
        text = ensure_import(text, ["join"], "node:path")
        path.write_text(text, encoding="utf-8")
        changed.append((path.name, len(hits)))

    for name, count in changed:
        print(f"{count:3d}  {name}")
    print(f"files changed: {len(changed)}, call sites: {sum(count for _, count in changed)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
