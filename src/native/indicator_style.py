"""Read the existing panel preferences without starting GTK or changing focus."""
import logging
import os
from pathlib import Path
import re

from desktop import orbit_settings
from .transport import action_response


_HEX = re.compile(r"#[0-9a-fA-F]{6}\Z")
_DEFINE = re.compile(r"@define-color\s+([A-Za-z_][A-Za-z0-9_-]*)\s+([^;]+);", re.IGNORECASE)
_IMPORT = re.compile(r'''@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?\s*;''', re.IGNORECASE)


def _config_home(config_home=None):
    # The broker forwards the owner's settings roots. Without either environment
    # value Path.home uses the account database for the ordinary default.
    return Path(config_home or os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")


def _gtk_accent(config_home):
    """Resolve explicit user GTK CSS colours and local imports, without GTK.

    This is not a theme engine. Installed theme resources, generated CSS
    functions and runtime GTK settings are not resolved by this limited reader.
    """
    root = Path(config_home).resolve()
    definitions = {}
    visited = set()

    def read(path, depth=0):
        try:
            path = path.resolve()
        except (OSError, RuntimeError):
            return ""
        if depth > 4 or len(visited) >= 16 or path in visited or not path.is_relative_to(root):
            return ""
        visited.add(path)
        try:
            with path.open("r", encoding="utf-8") as stream:
                value = stream.read(131073)
            if len(value) > 131072:
                return ""
        except (OSError, UnicodeError):
            return ""
        value = re.sub(r"/\*.*?\*/", "", value, flags=re.DOTALL)
        return _IMPORT.sub(lambda match: read(path.parent / match.group(1), depth + 1), value)

    def colour(value, seen=None):
        value = value.strip()
        if _HEX.fullmatch(value):
            return value.lower()
        if re.fullmatch(r"#[0-9a-fA-F]{3}", value):
            return "#" + "".join(character * 2 for character in value[1:].lower())
        seen = set() if seen is None else seen
        if value.startswith("@") and value[1:] not in seen:
            key = value[1:]
            return colour(definitions.get(key, ""), seen | {key})
        components = re.fullmatch(r"rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(?:1|1\.0+))?\s*\)", value)
        if components:
            channels = [int(component) for component in components.groups()]
            if all(channel <= 255 for channel in channels):
                return "#" + "".join(f"{channel:02x}" for channel in channels)
        return None

    # Prefer the GTK 4 user stylesheet, then the GTK 3 user stylesheet. Never
    # claim that a CSS value proves the running desktop theme's final colour.
    for version in ("gtk-4.0", "gtk-3.0"):
        definitions.clear()
        visited.clear()
        definitions.update((match.group(1), match.group(2)) for match in _DEFINE.finditer(read(root / version / "gtk.css")))
        for key in ("accent_bg_color", "theme_selected_bg_color"):
            resolved = colour(definitions.get(key, ""))
            if resolved:
                return resolved
    return None


def indicator_style(settings_path=None, config_home=None):
    """Normalize the owner's existing settings into fixed plugin IPC tokens."""
    directory = _config_home(config_home)
    settings, note = orbit_settings.load(settings_path or directory / "sbar-orbit" / "panel.json")
    chosen = settings["frameColor"]
    source = "owner-frame-color"
    if chosen == "accent":
        chosen = _gtk_accent(directory)
        source = "gtk-user-css" if chosen else "orbit-blue-fallback"
        if chosen is None:
            chosen = orbit_settings.DEFAULT_SETTINGS["frameColor"]
            message = "GTK accent could not be resolved without a display; using the original Orbit blue fallback"
            note = f"{note}; {message}" if note else message
    if not isinstance(chosen, str) or not _HEX.fullmatch(chosen):
        raise ValueError("Panel indicator colour was not normalized")
    return {"hex": chosen[1:].lower(), "pulse": int(settings["framePulse"]),
            "frame": int(settings["frame"]), "colourSource": source, "note": note}


def apply_indicator_style(transport):
    """Called only inside an admitted handoff, before claiming its window."""
    style = indicator_style()
    if style["note"]:
        logging.getLogger(__name__).warning("%s", style["note"])
    command = f"ghost-indicator-style {style['hex']} {style['pulse']} {style['frame']}"
    action_response("ghost-indicator-style", transport._exchange(command))
    return style
