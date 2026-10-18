"""Owner handoff release, bound to the committed isolated evidence. No runtime override.

The hold placed after the 6 October 2026 owner compositor crash lifts only for the exact plugin
source and Hyprland build that the evidence record measured: the old crash reproduced in the nested
lab and the corrected source passed the same claim. Any change to the plugin source, or another
compositor build, brings the hold back until new evidence is recorded.
"""
import json
from pathlib import Path

EVIDENCE = Path(__file__).resolve().parents[2] / "experiments/ghost-cursor/owner-handoff-release.json"
REFUSAL = "Owner display handoff is disabled after a compositor crash; isolated validation is required"


def released(evidence=EVIDENCE):
    try:
        record = json.loads(Path(evidence).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RuntimeError(REFUSAL) from error
    if (not isinstance(record, dict) or record.get("schema") != 1 or record.get("state") != "passed"
            or not isinstance(record.get("plugin"), dict) or not isinstance(record.get("hyprland"), dict)
            or len(str(record["plugin"].get("source_sha256", ""))) != 64
            or not str(record["hyprland"].get("abi_hash", ""))):
        raise RuntimeError(REFUSAL)
    return record


def require_owner_handoff(source_sha256=None, abi_hash=None, evidence=EVIDENCE):
    record = released(evidence)
    if source_sha256 is not None and source_sha256 != record["plugin"]["source_sha256"]:
        raise RuntimeError(REFUSAL + ": this plugin source has no release evidence")
    if abi_hash is not None and abi_hash != record["hyprland"]["abi_hash"]:
        raise RuntimeError(REFUSAL + ": this Hyprland build has no release evidence")
    return record
