#!/usr/bin/python3
"""Guarded private-lab adapter to the native owner controls runtime."""
import os
from pathlib import Path
import sys

import lab
lab.guard(os.environ)
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.settings import SettingsControl, SettingsWindow, checked_snapshot, describe, run
from src.native.budget import require_budget


def main():
    require_budget()
    return run(Path(os.environ["XDG_STATE_HOME"]) / "orbit-native-control",
               "Private lab preview. Changes apply only to this lab.",
               "org.sbar.Orbit.NativeSettingsPreview")


if __name__ == "__main__":
    raise SystemExit(main())
