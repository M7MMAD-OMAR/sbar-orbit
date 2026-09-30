#!/usr/bin/python3
"""Disposable native-sync oracle. Only its freshly created collection is changed."""
import base64
import configparser
import importlib.util
import json
import os
import re
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location("one_credential", Path(__file__).with_name("nextcloud-one-secret-service.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args):
        return None


def run(action, root):
    module.resource.setrlimit(module.resource.RLIMIT_CORE, (0, 0))
    if module.ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) != 0:
        raise ValueError("Could not disable credential-process dumps")
    if not re.fullmatch(r"/var/tmp/orbit-nextcloud-[^/]+", str(root)):
        raise ValueError("Requires a disposable probe root")
    configuration = root / "nextcloud-config/nextcloud.cfg"
    attributes = module.selected_attributes(configuration)
    config = configparser.ConfigParser(interpolation=None)
    config.optionxform = str
    with open(configuration, "rb", opener=lambda path, flags: os.open(path, flags | os.O_NOFOLLOW)) as stream:
        data = stream.read(1048577)
    if len(data) > 1048576:
        raise ValueError("Configuration exceeded its limit")
    text = data.decode("utf8")
    config.read_string(text)
    account_id = next(k.split("\\")[0] for k in config["Accounts"] if k.endswith("\\url"))
    base = config["Accounts"][account_id + "\\url"].rstrip("/")
    dav_user = config["Accounts"][account_id + "\\dav_user"]
    service = module.Secret.Service.get_sync(module.Secret.ServiceFlags.NONE, None)
    schema = module.Secret.Schema.new("org.qt.keychain", module.Secret.SchemaFlags.DONT_MATCH_NAME,
        {key: module.Secret.SchemaAttributeType.STRING for key in attributes})
    items = service.search_sync(schema, attributes, module.Secret.SearchFlags.NONE, None)
    if len(items) != 1 or items[0].get_locked():
        raise ValueError("Requires one unlocked matching credential")
    items[0].load_secret_sync(None)
    credential = items[0].get_secret().get_text()
    user = config["Accounts"][account_id + "\\webflow_user"]
    authorization = "Basic " + base64.b64encode((user + ":" + credential).encode()).decode()
    opener = build_opener(NoRedirect())
    receipt = root / "native-sync-receipt.json"
    if action == "prepare":
        state = {"collection": "orbit-native-sync-" + uuid.uuid4().hex, "created": False, "cleaned": False,
                 "localUploadObserved": False, "remoteDownloadObserved": False}
    else:
        state = json.loads(receipt.read_text())
    state["controlCredentialLoads"] = state.get("controlCredentialLoads", 0) + 1
    if not re.fullmatch(r"orbit-native-sync-[0-9a-f]{32}", state["collection"]):
        raise ValueError("Invalid disposable collection")
    endpoint = base + "/remote.php/dav/files/" + quote(dav_user, safe="") + "/" + state["collection"]

    def save():
        with open(receipt, "w", opener=lambda path, flags: os.open(path, flags, 0o600)) as stream:
            json.dump(state, stream)

    def request(method, suffix="", data=None):
        try:
            with opener.open(Request(endpoint + suffix, data=data, method=method,
                                     headers={"Authorization": authorization, "Content-Type": "text/plain"}), timeout=15) as response:
                return response.status, response.read(65536)
        except HTTPError as error:
            return error.code, b""

    local = root / "native-sync-files"
    save()
    if action == "prepare":
        state["creationUncertain"] = True
        save()
        status, _ = request("MKCOL")
        state["creationUncertain"] = False
        save()
        if status != 201:
            raise ValueError("Could not create a new disposable collection")
        state["created"] = True
        save()
        status, _ = request("PUT", "/server-seed.txt", b"Orbit native remote seed\n")
        if status not in (201, 204):
            raise ValueError("Could not seed disposable collection")
        local.mkdir(mode=0o700)
        (local / "client-seed.txt").write_bytes(b"Orbit native local seed\n")
        prefix = account_id + "\\Folders\\OrbitNativeSync\\"
        fields = {"localPath": str(local) + "/", "journalPath": ".orbit-sync.db", "targetPath": "/" + state["collection"],
                  "paused": "false", "ignoreHiddenFiles": "true", "virtualFilesMode": "off", "version": "2"}
        # Add the fresh folder within the observed flat Accounts section only.
        lines = text.splitlines(keepends=True)
        start = next(i for i, line in enumerate(lines) if line.strip() == "[Accounts]")
        end = next((i for i in range(start + 1, len(lines)) if lines[i].strip().startswith("[")), len(lines))
        lines[end:end] = [prefix + key + "=" + value + "\n" for key, value in fields.items()]
        with open(configuration, "w", opener=lambda path, flags: os.open(path, flags | os.O_NOFOLLOW)) as stream:
            stream.write("".join(lines))
    elif action == "observe":
        if not state["created"] or state["cleaned"]:
            raise ValueError("Collection is not owned and live")
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            status, payload = request("GET", "/client-seed.txt")
            state["localUploadObserved"] = status == 200 and payload == b"Orbit native local seed\n"
            incoming = local / "server-seed.txt"
            state["remoteDownloadObserved"] = incoming.exists() and incoming.read_bytes() == b"Orbit native remote seed\n"
            if state["localUploadObserved"] and state["remoteDownloadObserved"]:
                break
            time.sleep(1)
    elif action == "cleanup":
        if state.get("creationUncertain"):
            status, _ = request("PROPFIND")
            if status == 404:
                state["creationUncertain"] = False
                state["cleaned"] = True
            else:
                raise ValueError("Unacknowledged collection creation needs recovery")
        if state["created"] and not state["cleaned"]:
            status, _ = request("DELETE")
            if status not in (204, 404):
                raise ValueError("Disposable remote cleanup failed")
            status, _ = request("PROPFIND")
            state["cleaned"] = status == 404
            if not state["cleaned"]:
                raise ValueError("Disposable collection absence was not confirmed")
    else:
        raise ValueError("Unknown action")
    save()
    print(json.dumps({key: value for key, value in state.items() if key != "collection"}))


if __name__ == "__main__":
    run(sys.argv[1], Path(sys.argv[2]))
