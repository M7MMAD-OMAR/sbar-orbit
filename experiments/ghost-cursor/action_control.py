"""Compatibility import for the shared native owner control tests."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.control import ActionControl, ControlError
