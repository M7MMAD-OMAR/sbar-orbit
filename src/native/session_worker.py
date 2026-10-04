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


def main(directory, control_directory, plan_path):
    require_budget()
    directory = private_directory(directory)
    private_directory(control_directory)
    session = None
    requests = {}
    cached_bytes = 0
    with ActionControl(control_directory) as control:
        try:
            session = NativeSession(read_plan(plan_path), directory, control)
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
                        if method not in ("close", "close-application") and (len(requests) >= 10000 or cached_bytes >= 16 * 1024 * 1024):
                            raise SessionError("Native request cache limit reached")
                        if method == "launch" and not set(params) - {"argv", "configuration"}:
                            result = session.launch(params.get("argv"), params.get("configuration"))
                        elif method == "act":
                            result = session.execute(params)
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
                        response = {"ok": False, "error": {"code": code, "message": "Native request failed; see the private worker log"}}
                    requests[request_id] = (fingerprint, response)
                    cached_bytes += len(json.dumps(response).encode())
                sys.stdout.write(json.dumps({"requestId": request_id, **response}) + "\n")
                sys.stdout.flush()
                if session.closed:
                    break
        finally:
            if session is not None:
                session.close()


if __name__ == "__main__":
    main(*(Path(argument) for argument in sys.argv[1:]))
