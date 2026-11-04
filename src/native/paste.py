"""Refuse untypeable text when shared clipboard preservation cannot be guaranteed.

The plugin calls this fallback only after refusing the entire text before any key
is sent. wl-copy and wl-paste cannot atomically bind a snapshot to its selection
owner, replace it conditionally, or restore it only while still owning it. Reading
back matching bytes does not prove ownership and still races a later owner copy.
A fixed settle delay also cannot prove the target consumed the temporary offer.

Until an ownership-aware atomic mechanism exists, fail before reading or changing
CLIPBOARD or PRIMARY, and before sending a paste key. Ordinary native keymap text
and explicit application copy/paste actions are unaffected.
"""
from .host import UnsupportedText


def paste_text(plan, text, press_paste, runner=None, sleep=None):
    """Keep the fallback call shape, but never touch the shared selections."""
    raise UnsupportedText(
        "The native direct-text route cannot represent this text with the active keymap; clipboard paste fallback is unavailable "
        "because atomic clipboard ownership and restoration cannot be guaranteed. "
        "No paste key was sent and shared clipboard selections were not changed."
    )
