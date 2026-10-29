"""Deliver text the seat keymap cannot type through the shared clipboard, then restore the clipboard.

This runs only after the plugin refused the whole text before sending any key, so nothing was typed
and the paste is the first and only delivery. The previous clipboard text is put back afterwards.
A clipboard that holds anything other than text is never replaced, because it cannot be restored.
"""
import subprocess
import time

from .host import UnsupportedText

PASTE_SETTLE_SECONDS = 0.4
LIMIT = 1024 * 1024
TEXT_TYPES = ("text/", "UTF8_STRING", "STRING", "TEXT")


def clipboard_environment(plan):
    return {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "XDG_RUNTIME_DIR": plan["runtime"],
            "WAYLAND_DISPLAY": str(plan["runtime"]) + "/" + plan["display"]}


def run(argv, environment, data=None):
    return subprocess.run(argv, env=environment, input=data, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3)


def read_clipboard(environment, runner=run):
    """The current clipboard text, or None when it is empty. Anything else is refused."""
    listed = runner(["/usr/bin/wl-paste", "--list-types"], environment)
    types = listed.stdout.decode("utf-8", "replace").split()
    if listed.returncode != 0 or not types:
        return None
    if not any(kind.startswith(TEXT_TYPES) for kind in types):
        raise UnsupportedText("The clipboard holds non-text content that cannot be restored")
    result = runner(["/usr/bin/wl-paste", "--no-newline", "--type", "text"], environment)
    if result.returncode != 0 or len(result.stdout) > LIMIT:
        raise UnsupportedText("The clipboard text cannot be saved for restoration")
    return result.stdout


def write_clipboard(environment, data, runner=run):
    argv = ["/usr/bin/wl-copy", "--type", "text/plain;charset=utf-8"] if data is not None else ["/usr/bin/wl-copy", "--clear"]
    if runner(argv, environment, data).returncode != 0:
        raise UnsupportedText("The clipboard could not be written")


def paste_text(plan, text, press_paste, runner=run, sleep=time.sleep):
    environment = clipboard_environment(plan)
    saved = read_clipboard(environment, runner)
    write_clipboard(environment, text.encode("utf-8"), runner)
    try:
        press_paste()
        sleep(PASTE_SETTLE_SECONDS)
    finally:
        write_clipboard(environment, saved, runner)
    return "ok paste " + str(len(text)) + " characters"
