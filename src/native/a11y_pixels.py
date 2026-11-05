"""Conservative pixel-backed click regions for named GTK controls.

GTK bounds can omit widget offsets. An exact, unique rendered label is a useful
click region without inventing the missing padding. This does not reconstruct
the full widget bounds or correct icon-only controls. OCR is optional; failure
leaves provider geometry untouched. Application text stays inside the worker.
"""
import copy
import csv
import ctypes
import io
import math
import os
import resource
import signal
import subprocess
import tempfile
import time
import unicodedata

from .a11y import _trim

MAX_TSV = 262144
MAX_IMAGE = 8 * 1024 * 1024
ROLES = {"table cell", "list item", "button", "push button", "toggle button", "check box", "radio button", "link"}
_LIBC = ctypes.CDLL(None, use_errno=True)


def _key(text):
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def _label(node):
    name = node.get("name", "")
    if not isinstance(name, str) or node.get("role") not in ROLES:
        return ""
    if node.get("role") == "table cell" and name.endswith(". Folder"):
        name = name[:-8]
    key = _key(name)
    return key if 3 <= len(key) <= 120 else ""


def calibrate_from_tsv(tree, raw, pixels, surface):
    """Use only unique complete high-confidence labels near their original box."""
    if not isinstance(tree, dict) or tree.get("status") != "ok" or tree.get("toolkit") != "GTK":
        return tree
    try:
        if type(raw) is not bytes or len(raw) > MAX_TSV:
            return tree
        pw, ph = pixels
        sw, sh = surface
        if any(type(n) not in (int, float) or not math.isfinite(n) or n <= 0 for n in (pw, ph, sw, sh)):
            return tree
        if pw > 4096 or ph > 4096 or not 0.5 <= pw / sw <= 4 or not 0.5 <= ph / sh <= 4:
            return tree
        words = []
        reader = csv.DictReader(io.StringIO(raw.decode("utf-8")), delimiter="\t")
        for index, row in enumerate(reader):
            if index >= 2048:
                return tree
            if row.get("level") != "5":
                continue
            text = row["text"]
            x, y, w, h = (int(row[k]) for k in ("left", "top", "width", "height"))
            confidence = float(row["conf"])
            if not text or len(text) > 120 or not math.isfinite(confidence):
                continue
            if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > pw or y + h > ph:
                return tree
            words.append((_key(text), x, y, w, h, (row["page_num"], row["block_num"]), confidence,
                          (row["page_num"], row["block_num"], row["par_num"], row["line_num"])))
        nodes = tree.get("nodes")
        if not isinstance(nodes, list) or len(nodes) > 300 or not all(isinstance(node, dict) for node in nodes):
            return tree
        labels = [_label(node) for node in nodes]
        result, corrected = copy.deepcopy(tree), 0
        for node, label in zip(result["nodes"], labels):
            if not label or labels.count(label) != 1:
                continue
            candidates = []
            for start in range(len(words)):
                # A word inside a longer OCR line is not evidence of a complete
                # control label. Skipping its neighbours could select another control.
                if start > 0 and words[start - 1][7] == words[start][7]:
                    continue
                text, group, selected = "", words[start][5], []
                for word in words[start:start + 12]:
                    if word[5] != group:
                        break
                    text += (" " if text and not text.endswith("-") else "") + word[0]
                    selected.append(word)
                    if text == label:
                        after = start + len(selected)
                        if after < len(words) and words[after][7] == selected[-1][7]:
                            break
                        x = min(w[1] for w in selected)
                        y = min(w[2] for w in selected)
                        right = max(w[1] + w[3] for w in selected)
                        bottom = max(w[2] + w[4] for w in selected)
                        # Wrapped lines must still be one compact rendered label.
                        if bottom - y <= 90 * ph / sh and right - x <= 400 * pw / sw:
                            candidates.append(([math.floor(x * sw / pw), math.floor(y * sh / ph),
                                                math.ceil(right * sw / pw), math.ceil(bottom * sh / ph)],
                                               all(w[6] >= 90 for w in selected)))
                        break
                    if not label.startswith(text):
                        break
            if len(candidates) != 1 or not candidates[0][1]:
                continue
            original = node.get("box")
            if (not isinstance(original, list) or len(original) != 4
                    or any(type(n) not in (int, float) or not math.isfinite(n) for n in original)
                    or original[2] <= 0 or original[3] <= 0):
                continue
            x, y, right, bottom = candidates[0][0]
            if (abs((x + right) / 2 - (original[0] + original[2] / 2)) > 64
                    or abs((y + bottom) / 2 - (original[1] + original[3] / 2)) > 64):
                continue
            node["providerBox"] = list(original)
            node["box"] = [x, y, right - x, bottom - y]
            node["boxSource"] = "capture-text"
            corrected += 1
        if not corrected:
            return tree
        result["nodes"], cut = _trim(result["nodes"])
        if cut:
            result["truncated"], result["complete"] = cut, False
        result["geometryCalibration"] = {"source": "capture-text", "corrected": sum("providerBox" in node for node in result["nodes"])}
        return result
    except (KeyError, TypeError, ValueError, UnicodeError, csv.Error):
        return tree


def _limits(parent):
    # This Linux-only native worker never leaves OCR alive after worker death.
    if os.getppid() != parent or _LIBC.prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != parent:
        os._exit(71)
    for kind, wanted in [(resource.RLIMIT_CORE, 0), (resource.RLIMIT_FSIZE, MAX_TSV + 1),
                         (resource.RLIMIT_AS, 512 * 1024 * 1024), (resource.RLIMIT_CPU, 2)]:
        soft, hard = resource.getrlimit(kind)
        cap = min([wanted] + [n for n in (soft, hard) if n != resource.RLIM_INFINITY])
        resource.setrlimit(kind, (cap, cap))


def _ocr(image, deadline):
    """One fixed local process, bounded files/memory/time; no shell or retry."""
    if type(image) is not bytes or not image or len(image) > MAX_IMAGE:
        return None
    timeout = min(0.8, deadline - time.monotonic())
    if timeout <= 0.05:
        return None
    parent = os.getpid()
    with tempfile.TemporaryFile() as output:
        child = subprocess.Popen(["/usr/bin/tesseract", "stdin", "stdout", "-l", "eng", "--psm", "11", "tsv"],
                                 stdin=subprocess.PIPE, stdout=output, stderr=subprocess.DEVNULL,
                                 env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "OMP_THREAD_LIMIT": "1"},
                                 start_new_session=True, preexec_fn=lambda: _limits(parent))
        try:
            child.communicate(image, timeout=timeout)
            if child.returncode != 0 or time.monotonic() >= deadline:
                return None
            output.seek(0)
            raw = output.read(MAX_TSV + 1)
            return raw if len(raw) <= MAX_TSV else None
        except subprocess.TimeoutExpired:
            return None
        finally:
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                # Reaping is not inferred from signal delivery.
                child.wait(timeout=0.2)


def calibrate(tree, image, pixels, surface, deadline):
    if (not isinstance(tree, dict) or tree.get("status") != "ok" or tree.get("toolkit") != "GTK"
            or time.monotonic() >= deadline):
        return tree
    try:
        raw = _ocr(image, deadline)
        if raw is None or time.monotonic() >= deadline:
            return tree
        result = calibrate_from_tsv(tree, raw, pixels, surface)
        return result if time.monotonic() < deadline else tree
    except (OSError, subprocess.SubprocessError):
        return tree
