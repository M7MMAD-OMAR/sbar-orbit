"""Framed worker for explicitly handed-off, already-open applications."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.existing import ExistingApplicationSession
from src.native.session_worker import main

if __name__ == "__main__":
    main(*(Path(value) for value in sys.argv[1:]), session_type=ExistingApplicationSession)
