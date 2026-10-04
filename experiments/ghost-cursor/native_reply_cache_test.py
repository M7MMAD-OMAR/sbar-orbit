#!/usr/bin/python3
"""Capture cache storage and exact replay semantics, without a display."""
from pathlib import Path
import sys
import unittest
import io
import json
import importlib.util
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.session_worker import ReplyCache
import src.native.session_worker as worker

if len(sys.argv) == 2:
    spec = importlib.util.spec_from_file_location("saved_native_worker", sys.argv.pop())
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)


class CaptureCache(unittest.TestCase):
    def test_streamed_captures_do_not_refuse_the_next_mutation(self):
        class Control:
            def __init__(self, *_): pass
            def __enter__(self): return self
            def __exit__(self, *_): pass
        class Session:
            def __init__(self, *_): self.closed = False
            def execute(self, value):
                return {"image": "x" * (1024 * 1024)} if value["type"] == "observe" else {"delivered": True}
            def close(self): self.closed = True
        requests = [{"requestId": f"{index:032x}", "method": "act", "params": {"type": "observe" if index < 24 else "text"}}
                    for index in range(25)]
        output = io.StringIO()
        incoming = SimpleNamespace(buffer=io.BytesIO("".join(json.dumps(value) + "\n" for value in requests).encode()))
        with patch.object(worker, "require_budget"), patch.object(worker, "private_directory", side_effect=lambda path: path), \
             patch.object(worker, "read_plan", return_value={}), patch.object(worker, "ActionControl", Control), \
             patch.object(worker, "NativeSession", Session), patch.object(sys, "stdin", incoming), patch.object(sys, "stdout", output):
            worker.main(Path("/unused"), Path("/unused-control"), Path("/unused-plan"))
        output.seek(0)
        replies = [json.loads(line)["ok"] for line in output]
        self.assertEqual(replies, [True] * 25, "Capture image retention exhausted the next action's metadata budget")

    def test_images_do_not_accumulate_or_block_later_mutations(self):
        cache = ReplyCache()
        image = "x" * (9 * 1024 * 1024)
        for index in range(8):
            cache.retain(str(index), "fingerprint-" + str(index), {"ok": True, "result": {"image": image, "width": 1}})
        images = [reply["result"]["image"] for _, reply in cache.requests.values() if reply.get("ok")]
        self.assertEqual(len(images), 1)
        self.assertLess(cache.metadata_bytes, 4096)
        self.assertEqual(cache.get("0"), ("fingerprint-0", {"ok": False, "error": {
            "code": "REPLAY_EXPIRED", "message": "Older capture reply expired; use a fresh observation request ID"}}))
        self.assertEqual(cache.get("7")[1]["result"]["image"], image)
        mutation = {"ok": True, "result": {"delivered": True}}
        cache.retain("mutation", "exact", mutation)
        self.assertEqual(cache.get("mutation"), ("exact", mutation))
        cache.retain("next-image", "next", {"ok": True, "result": {"image": image}})
        self.assertEqual(cache.get("mutation"), ("exact", mutation))
        self.assertEqual(cache.get("7")[0], "fingerprint-7")
        self.assertEqual(cache.get("7")[1]["error"]["code"], "REPLAY_EXPIRED")
        self.assertEqual(cache.metadata_bytes, sum(cache.size(reply) for _, reply in cache.requests.values()))


if __name__ == "__main__":
    unittest.main()
