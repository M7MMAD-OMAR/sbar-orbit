"""Validate the plugin actually loaded by the prepared compositor."""
import hashlib
import re
from pathlib import Path

PLUGIN_SOURCE = Path(__file__).resolve().parents[2] / "experiments/ghost-cursor/plugin/ghostinput.cpp"


class NativeCompatibilityError(RuntimeError):
    """The installed code and prepared compositor need owner integration."""


def require_native_plugin(source_sha256, abi_hash, *, expected_abi):
    if (not isinstance(source_sha256, str) or not re.fullmatch(r"[a-f0-9]{64}", source_sha256)
            or not isinstance(abi_hash, str) or not abi_hash or not isinstance(expected_abi, str)
            or not expected_abi or abi_hash != expected_abi):
        raise NativeCompatibilityError("Loaded native plugin build does not match the prepared compositor ABI")
    expected_source = hashlib.sha256(PLUGIN_SOURCE.read_bytes()).hexdigest()
    if source_sha256 != expected_source:
        raise NativeCompatibilityError("Loaded native plugin source differs from this Orbit installation; rebuild and reload the prepared plugin")
    return {"source_sha256": source_sha256, "abi_hash": abi_hash}
