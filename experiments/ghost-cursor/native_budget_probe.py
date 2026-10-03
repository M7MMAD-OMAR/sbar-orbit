#!/usr/bin/python3
"""Verify a real lab child inherits the enforced shared resource budget."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid

source = Path(sys.argv[1]) if len(sys.argv) == 2 else Path(__file__).with_name("lab.py")
spec = importlib.util.spec_from_file_location("budget_lab", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory(prefix="gl-budget-", dir="/tmp") as directory:
    lab = Path(directory)
    (lab / "home").mkdir(mode=0o700)
    code = "import sys; sys.path.insert(0, " + repr(str(Path(__file__).resolve().parents[2])) + "); from src.native.budget import require_budget; require_budget(); print('shared-budget-child: pass')"
    args = module.scoped(lab, uuid.uuid4().hex, ["/usr/bin/python3", "-c", code], module.base_env(lab))
    result = subprocess.run(args, capture_output=True, text=True, timeout=5, cwd=Path(__file__).resolve().parents[2])
    print(result.stdout, end="")
    print(result.stderr, end="", file=sys.stderr)
    raise SystemExit(result.returncode)
