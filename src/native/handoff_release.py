"""Owner handoff release, bound to the committed isolated evidence. No runtime override.

The old crash reproduction and corrected nested lab run are necessary but do not prove live
input delivery or selection isolation. Both isolated evidence and every live acceptance condition
must pass before the exact recorded plugin and compositor build can enter an owner session.
"""
import json
import re
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
            or not isinstance(record["plugin"].get("source_sha256"), str)
            or not re.fullmatch(r"[a-f0-9]{64}", record["plugin"]["source_sha256"])
            or not isinstance(record["hyprland"].get("abi_hash"), str)
            or not record["hyprland"]["abi_hash"]
            or not isinstance(record.get("ownerAcceptance"), dict)
            or record["ownerAcceptance"].get("state") != "passed"
            or any(record["ownerAcceptance"].get(key) is not True for key in
                   ("inputDelivered", "selectionIsolated", "ownerFocusPreserved",
                    "ownerPointerPreserved", "handbackVerified"))):
        raise RuntimeError(REFUSAL)
    return record


def require_owner_handoff(source_sha256=None, abi_hash=None, evidence=EVIDENCE):
    record = released(evidence)
    if source_sha256 is not None and source_sha256 != record["plugin"]["source_sha256"]:
        raise RuntimeError(REFUSAL + ": this plugin source has no release evidence")
    if abi_hash is not None and abi_hash != record["hyprland"]["abi_hash"]:
        raise RuntimeError(REFUSAL + ": this Hyprland build has no release evidence")
    return record
