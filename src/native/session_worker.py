"""Private line-framed native session worker, with no mode-changing requests."""
import hashlib
import json
from pathlib import Path
import sys
import traceback

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.application import private_directory
from src.native.budget import require_budget
from src.native.control import ActionControl, ControlError
from src.native.host import read_plan
from src.native.session import NativeSession, SessionError, identifier
from src.native.host import verify_host


class ReplyCache:
    """Retain mutation outcomes and at most one image, with explicit older replay expiry."""
    def __init__(self):
        self.requests = {}
        self.metadata_bytes = 0
        self.image_id = None

    def __len__(self):
        return len(self.requests)

    def get(self, request_id):
        return self.requests.get(request_id)

    @staticmethod
    def size(response):
        result = response.get("result")
        if isinstance(result, dict) and "image" in result:
            response = {**response, "result": {key: value for key, value in result.items() if key != "image"}}
        return len(json.dumps(response).encode())

    def retain(self, request_id, fingerprint, response):
        result = response.get("result")
        if response.get("ok") and isinstance(result, dict) and "image" in result:
            if self.image_id is not None:
                previous, old = self.requests[self.image_id]
                expired = {"ok": False, "error": {"code": "REPLAY_EXPIRED", "message": "Older capture reply expired; use a fresh observation request ID"}}
                self.requests[self.image_id] = (previous, expired)
                self.metadata_bytes += self.size(expired) - self.size(old)
            self.image_id = request_id
        self.requests[request_id] = (fingerprint, response)
        self.metadata_bytes += self.size(response)


def main(directory, control_directory, plan_path, session_type=None):
    session_type = NativeSession if session_type is None else session_type
    require_budget()
    directory = private_directory(directory)
    private_directory(control_directory)
    session = None
    requests = ReplyCache()
    with ActionControl(control_directory) as control:
        try:
            session = session_type(read_plan(plan_path), directory, control)
            for raw in iter(lambda: sys.stdin.buffer.readline(65537), b""):
                if len(raw) > 65536 or not raw.endswith(b"\n"):
                    raise SessionError("Invalid native request framing")
                request = json.loads(raw)
                if (not isinstance(request, dict) or set(request) != {"requestId", "method", "params"}
                        or not isinstance(request["params"], dict)):
                    raise SessionError("Invalid native worker request")
                request_id = identifier(request["requestId"])
                fingerprint = hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()
                existing = requests.get(request_id)
                if existing is not None:
                    if existing[0] != fingerprint:
                        response = {"ok": False, "error": {"code": "REQUEST_CONFLICT", "message": "Request identity conflicts"}}
                    else:
                        response = existing[1]
                else:
                    if len(requests) >= 10032:
                        raise SessionError("Native request limit reached; closing owned session")
                    try:
                        params, method = request["params"], request["method"]
                        if method not in ("close", "close-application") and (len(requests) >= 10000 or requests.metadata_bytes >= 16 * 1024 * 1024):
                            raise SessionError("Native request cache limit reached")
                        if method == "status" and not params:
                            verify_host(session.plan)
                            result = {"ready": True}
                        elif method == "launch" and not set(params) - {"argv", "configuration"}:
                            result = session.launch(params.get("argv"), params.get("configuration"))
                        elif method == "act":
                            result = session.execute(params)
                        elif method in ("claim", "candidates", "open") and session_type is not NativeSession:
                            result = getattr(session, method)(params)
                        elif method in ("pause", "resume") and not params and session_type is not NativeSession:
                            result = session.set_paused(method == "pause")
                        elif method == "close-application" and set(params) == {"appId"}:
                            session.close_application(params["appId"])
                            result = {"closed": True}
                        elif method == "close" and not params:
                            session.close()
                            result = {"closed": True}
                        else:
                            raise SessionError("Unsupported native worker request")
                        response = {"ok": True, "result": result}
                    except BaseException as error:
                        traceback.print_exception(error, file=sys.stderr)
                        code = ("APPROVAL_REQUIRED" if isinstance(error, ControlError) and str(error).startswith("Protected mode")
                                else "INVALID_REQUEST" if isinstance(error, SessionError) else "NATIVE_FAILED")
                        message = str(error)[:300] if session_type is not NativeSession and isinstance(error, SessionError) else "Native request failed; see the private worker log"
                        response = {"ok": False, "error": {"code": code, "message": message}}
                    requests.retain(request_id, fingerprint, response)
                sys.stdout.write(json.dumps({"requestId": request_id, **response}) + "\n")
                sys.stdout.flush()
                if session.closed:
                    break
        finally:
            if session is not None:
                session.close()


if __name__ == "__main__":
    main(*(Path(argument) for argument in sys.argv[1:]))
