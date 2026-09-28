#!/usr/bin/python3
"""Exercise two Codex clients and a real private Orbit browser in one fixture.

Run with:
    bun run scripts/limited.ts /usr/bin/python3 experiments/codex-shared-real-orbit-mcp-probe.py

All Codex state, model responses, broker state, and browser data are disposable.
The person's Desktop app and personal profiles are never opened.
"""

import runpy
from pathlib import Path


if __name__ == "__main__":
    probe = runpy.run_path(str(Path(__file__).with_name("codex-real-orbit-mcp-probe.py")))
    probe["main"](shared_clients=True)
