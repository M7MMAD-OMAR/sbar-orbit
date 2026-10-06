#!/usr/bin/env python3
"""Actual installed host action paths against a disposable Orbit browser.

Run one host at a time with a coordinator slot:
 bun run scripts/limited.ts python3 experiments/host-action-acceptance.py codex --output /var/tmp/result.json
Only local deterministic model responses are used. No generic MCP client is used.
"""
import argparse
import base64
import hashlib
import http.client
import http.server
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import socket
import socketserver
import subprocess
import tempfile
import threading
import time
from urllib.parse import urlsplit

PROJECT = Path(__file__).resolve().parents[1]


def private_environment(root):
    for name in ('home', 'codex', 'claude', 'hermes', 'config', 'cache', 'data', 'state', 'runtime', 'work'):
        (root / name).mkdir(mode=0o700)
    return {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(root / 'home'),
            'CODEX_HOME': str(root / 'codex'), 'CLAUDE_CONFIG_DIR': str(root / 'claude'),
            'HERMES_HOME': str(root / 'hermes'), 'XDG_CONFIG_HOME': str(root / 'config'),
            'XDG_CACHE_HOME': str(root / 'cache'), 'XDG_DATA_HOME': str(root / 'data'),
            'XDG_STATE_HOME': str(root / 'state'), 'XDG_RUNTIME_DIR': str(root / 'runtime'),
            'ORBIT_USAGE_DIR': str(root / 'usage'), 'ORBIT_CONVERSATION_ID': 'disposable-host-acceptance',
            'HTTP_PROXY': 'http://127.0.0.1:9', 'HTTPS_PROXY': 'http://127.0.0.1:9',
            'ALL_PROXY': 'http://127.0.0.1:9', 'NO_PROXY': '127.0.0.1,localhost',
            'DISABLE_TELEMETRY': '1', 'DISABLE_ERROR_REPORTING': '1',
            'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'CLAUDE_CODE_DISABLE_AUTO_UPDATE': '1'}


def stop(child):
    if child is None:
        return
    # These process groups were created by this probe, never shared services.
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=3)
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('localhost', timeout=15)
        self.path = str(path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


def rpc_call(path, method, params=None):
    connection = UnixConnection(path)
    try:
        connection.request('POST', '/rpc', json.dumps({'method': method, 'params': params or {}}),
                           {'Content-Type': 'application/json'})
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()


class JsonRpc:
    def __init__(self, child, event_sink=None):
        self.child = child
        self.event_sink = event_sink
        self.buffer = bytearray()
        self.messages = []
        self.selector = selectors.DefaultSelector()
        os.set_blocking(child.stdout.fileno(), False)
        self.selector.register(child.stdout, selectors.EVENT_READ)

    def pump(self):
        if not self.selector.select(0.1):
            return
        data = os.read(self.child.stdout.fileno(), 65536)
        if not data:
            raise RuntimeError('app-server closed stdout')
        self.buffer.extend(data)
        while b'\n' in self.buffer:
            line, _, rest = self.buffer.partition(b'\n')
            self.buffer[:] = rest
            if line:
                message = json.loads(line)
                self.messages.append(message)
                item = message.get('params', {}).get('item', {})
                if self.event_sink is not None and message.get('method') == 'item/completed' and item.get('type') == 'mcpToolCall':
                    self.event_sink.append(item)

    def send(self, method, params=None, request_id=None):
        message = {'method': method}
        if params is not None:
            message['params'] = params
        if request_id is not None:
            message['id'] = request_id
        self.child.stdin.write((json.dumps(message) + '\n').encode())
        self.child.stdin.flush()

    def call(self, request_id, method, params):
        self.send(method, params, request_id)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            self.pump()
            for index, message in enumerate(self.messages):
                if message.get('id') == request_id:
                    result = self.messages.pop(index)
                    if 'error' in result:
                        raise RuntimeError(f'{method}: {result["error"]}')
                    return result['result']
        raise TimeoutError(method)


def responses_stream(number, name, arguments):
    item = ({'id': f'call_{number}', 'type': 'function_call', 'status': 'completed',
             'call_id': f'callid_{number}', 'namespace': 'mcp__orbit', 'name': name,
             'arguments': json.dumps(arguments)} if name else
            {'id': f'message_{number}', 'type': 'message', 'status': 'completed',
             'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'done', 'annotations': []}]})
    pending = {**item, 'status': 'in_progress'}
    pending['arguments' if name else 'content'] = '' if name else []
    events = [{'type': 'response.output_item.added', 'output_index': 0, 'item': pending}]
    if name:
        events += [{'type': 'response.function_call_arguments.delta', 'item_id': item['id'],
                    'output_index': 0, 'delta': item['arguments']},
                   {'type': 'response.function_call_arguments.done', 'item_id': item['id'],
                    'output_index': 0, 'arguments': item['arguments']}]
    events += [{'type': 'response.output_item.done', 'output_index': 0, 'item': item},
               {'type': 'response.completed', 'response': {'id': f'response_{number}',
                'object': 'response', 'created_at': int(time.time()), 'status': 'completed',
                'model': 'gpt-5.1', 'output': [item],
                'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}}]
    return (''.join(f'event: {event["type"]}\ndata: {json.dumps(event)}\n\n' for event in events)
            + 'data: [DONE]\n\n').encode()


def anthropic_stream(number, name, arguments):
    content = ({'type': 'tool_use', 'id': f'tool_{number}', 'name': f'mcp__orbit__{name}', 'input': {}}
               if name else {'type': 'text', 'text': ''})
    delta = ({'type': 'input_json_delta', 'partial_json': json.dumps(arguments)}
             if name else {'type': 'text_delta', 'text': 'done'})
    events = [{'type': 'message_start', 'message': {'id': f'msg_{number}', 'type': 'message',
               'role': 'assistant', 'model': 'claude-sonnet-4-6', 'content': [],
               'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': 1, 'output_tokens': 0}}},
              {'type': 'content_block_start', 'index': 0, 'content_block': content},
              {'type': 'content_block_delta', 'index': 0, 'delta': delta},
              {'type': 'content_block_stop', 'index': 0},
              {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use' if name else 'end_turn',
               'stop_sequence': None}, 'usage': {'output_tokens': 1}}, {'type': 'message_stop'}]
    return ''.join(f'event: {event["type"]}\ndata: {json.dumps(event)}\n\n' for event in events).encode()


def summarize(result):
    if isinstance(result, dict) and 'image' in result:
        image = base64.b64decode(result['image'], validate=True)
        return {**{k: v for k, v in result.items() if k != 'image'},
                'imageBytes': len(image), 'imageSha256': hashlib.sha256(image).hexdigest()}
    return result


def source_identity():
    names = subprocess.check_output(['git', 'ls-files', '-z', 'src', 'scripts', 'bun.lock',
                                      'package.json', 'bunfig.toml'], cwd=PROJECT).decode().split('\0')
    names += ['experiments/host-action-acceptance.py', 'experiments/host-action-acceptance-broker.ts', 'experiments/host-action-acceptance.test.py', 'experiments/host-action-acceptance-compare.py', 'src/cli-output.ts', 'tests/cli-output.test.ts', 'tests/platform-support.ts']
    digests = {name: hashlib.sha256((PROJECT / name).read_bytes()).hexdigest() for name in sorted(set(names)) if name}
    return {'gitHead': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=PROJECT).decode().strip(),
            'files': digests, 'sha256': hashlib.sha256(json.dumps(digests, sort_keys=True).encode()).hexdigest()}


def expanded(value):
    """Walk only the host model request's latest returned tool envelope."""
    yield value
    if isinstance(value, dict):
        for child in value.values():
            yield from expanded(child)
    elif isinstance(value, list):
        for child in value:
            yield from expanded(child)
    elif isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (ValueError, TypeError):
            # Codex prefixes returned MCP text with its wall time and Output label.
            for line in value.splitlines():
                if line.startswith(('{', '[')):
                    try:
                        parsed_line = json.loads(line)
                    except ValueError:
                        continue
                    yield from expanded(parsed_line)
            return
        if isinstance(parsed, (dict, list)):
            yield from expanded(parsed)


def latest_tool_output(body, host):
    if host == 'codex':
        inputs = body.get('input', [])
        indexes = [i for i, v in enumerate(inputs) if v.get('type') == 'function_call_output']
        if not indexes:
            raise AssertionError('Actual Codex tool result absent')
        index = indexes[-1]
        return [inputs[index]['output'], *inputs[index + 1:]]
    outputs = [c for m in body.get('messages', []) for c in m.get('content', [])
               if isinstance(c, dict) and c.get('type') == 'tool_result']
    if not outputs or outputs[-1].get('is_error'):
        raise AssertionError('Actual Claude successful tool result absent')
    return outputs[-1]['content']


def delivered_result(body, host, expected, observe=False, image_output=None):
    output = latest_tool_output(body, host)
    nodes = list(expanded(output))
    # Ignore relay-only image hash fields while matching actual image metadata.
    wanted = {k: v for k, v in expected.items() if k not in ('imageBytes', 'imageSha256')} if observe else expected
    matches = [v for v in nodes if v == wanted]
    assert matches, 'Host tool result differs from broker result'
    actual = matches[0]
    if not observe:
        return actual, None
    payloads = []
    image_nodes = list(expanded(image_output)) if image_output is not None else nodes
    for node in image_nodes:
        if not isinstance(node, dict):
            continue
        if node.get('type') == 'image' and isinstance(node.get('source'), dict):
            payloads.append(node['source'].get('data', ''))
        if node.get('type') in ('input_image', 'image_url'):
            url = node.get('image_url', '')
            if isinstance(url, dict):
                url = url.get('url', '')
            if isinstance(url, str) and url.startswith('data:'):
                payloads.append(url.partition(',')[2])
        if node.get('type') == 'image' and isinstance(node.get('data'), str):
            payloads.append(node['data'])
    decoded = [base64.b64decode(v, validate=True) for v in payloads if v]
    assert decoded, 'Actual host-delivered observation image absent'
    image = decoded[-1]
    assert hashlib.sha256(image).hexdigest() == expected['imageSha256'], 'Host image bytes changed'
    return actual, image


def next_call(body, host, number, sequence, calls, host_event=None):
    name, arguments = sequence[number] if number < len(sequence) else (None, {})
    if number:
        assert len(calls) == number and calls[-1]['response'].get('ok'), 'Actual prior broker call absent/failed'
        if number == 6 and host == 'codex':
            invoked = [v for v in body['input'] if v.get('type') == 'function_call']
            sid = json.loads(invoked[-1]['arguments'])['sessionId']
            assert host_event and host_event.get('id') == 'callid_5' and host_event.get('server') == 'orbit'
            assert host_event.get('tool') == 'orbit_observe' and host_event.get('status') == 'completed' and not host_event.get('error')
            assert host_event.get('arguments') == {'sessionId': sid}, 'Host observe event is not the exact request/session'
        result, image = delivered_result(body, host, calls[-1]['response']['result'], number == 6,
            host_event['result'] if number == 6 and host == 'codex' else None)
        if number == 1:
            sid = result['sessionId']
        else:
            # Use the actual prior host request's session ID, never a relay oracle.
            if host == 'codex':
                invoked = [v for v in body['input'] if v.get('type') == 'function_call']
                sid = json.loads(invoked[-1]['arguments'])['sessionId']
            else:
                invoked = [c for m in body['messages'] for c in m.get('content', [])
                           if isinstance(c, dict) and c.get('type') == 'tool_use']
                sid = invoked[-1]['input']['sessionId']
        if name:
            arguments = {**arguments, 'sessionId': sid}
        return name, arguments, image
    return name, arguments, None


def process_tree(root_pid):
    records = {}
    for path in Path('/proc').glob('[0-9]*/stat'):
        try:
            text = path.read_text()
            fields = text[text.rfind(')') + 2:].split()
            records[int(path.parent.name)] = {'pid': int(path.parent.name), 'parent': int(fields[1]),
                                              'startTicks': fields[19], 'state': fields[0]}
        except (OSError, ValueError, IndexError):
            pass
    owned = {root_pid}
    while True:
        children = {pid for pid, record in records.items() if record['parent'] in owned}
        if children <= owned:
            break
        owned |= children
    return [records[pid] for pid in sorted(owned - {root_pid}) if pid in records]


def alive_witnesses(witnesses):
    survivors = []
    for witness in witnesses:
        try:
            text = Path(f"/proc/{witness['pid']}/stat").read_text()
            fields = text[text.rfind(')') + 2:].split()
            if fields[19] == witness['startTicks'] and fields[0] != 'Z':
                survivors.append(witness)
        except (OSError, IndexError):
            pass
    return survivors


def jpeg_dimensions(image):
    assert image.startswith(b'\xff\xd8'), 'Observation is not JPEG'
    offset = 2
    while offset < len(image):
        assert image[offset] == 255, 'Invalid JPEG marker'
        while image[offset] == 255:
            offset += 1
        marker = image[offset]
        offset += 1
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            continue
        length = int.from_bytes(image[offset:offset + 2], 'big')
        assert length >= 2 and offset + length <= len(image), 'Invalid JPEG segment'
        if marker in (0xC0, 0xC1, 0xC2):
            return int.from_bytes(image[offset + 5:offset + 7], 'big'), int.from_bytes(image[offset + 3:offset + 5], 'big')
        offset += length
    raise AssertionError('JPEG dimensions absent')


def run(host, launcher, image_path):
    bun = shutil.which('bun')
    if not bun:
        raise RuntimeError('Bun absent')
    evidence = {'host': host, 'state': 'failed', 'tier': 'Limited', 'source': source_identity(),
                'limit': 'Disposable Fedora browser and deterministic loopback model; provider reasoning, accounts, native and other OS hosts not measured',
                'brokerCalls': [], 'modelRequests': [], 'submissions': [], 'hostEvents': [], 'deliveryChecks': [],
                'launcher': {'path': launcher, 'resolved': str(Path(launcher).resolve()),
                  'sha256': hashlib.sha256(Path(launcher).resolve().read_bytes()).hexdigest()}}
    with tempfile.TemporaryDirectory(prefix='orbit-host-action-', dir='/var/tmp') as temporary:
        root = Path(temporary)
        env = private_environment(root)
        if host in ('codex', 'claude'):
            version = subprocess.run([launcher, '--version'], cwd=root / 'work', env=env, capture_output=True, timeout=5)
            assert version.returncode == 0, 'Host version unavailable'
            evidence['launcher']['version'] = version.stdout.decode().strip()
            assert (host + '-cli' in evidence['launcher']['version'] if host == 'codex' else 'Claude Code' in evidence['launcher']['version']), 'Unexpected installed host identity'
        broker_path, relay_path = root / 'broker.sock', root / 'relay.sock'
        env['ORBIT_SOCKET'] = str(relay_path)
        broker = app = None
        servers = []
        workers = []
        sequence = []
        witnesses = []

        class Fixture(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                page = b'''<title>Orbit host acceptance</title><input id="value"><button id="submit" onclick="fetch('/submit',{method:'POST',body:document.querySelector('#value').value}).then(r=>r.text()).then(t=>document.querySelector('#result').textContent=t)">Submit</button><p id="result">empty</p>'''
                self.send_response(200)
                self.send_header('Content-Length', str(len(page)))
                self.end_headers()
                self.wfile.write(page)

            def do_POST(self):
                value = self.rfile.read(int(self.headers['Content-Length'])).decode()
                evidence['submissions'].append(value)
                payload = value.encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args):
                pass

        class Relay(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                status, body = rpc_call(broker_path, request['method'], request.get('params'))
                evidence['brokerCalls'].append({'method': request['method'], 'params': request.get('params'),
                    'response': {**body, 'result': summarize(body.get('result'))}})
                payload = json.dumps(body).encode()
                self.send_response(status)
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args):
                pass

        class Model(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                if urlsplit(self.path).path.endswith('/count_tokens'):
                    payload = b'{"input_tokens":1}'
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                else:
                    number = len(evidence['modelRequests'])
                    evidence['modelRequests'].append({'path': self.path,
                        'toolNames': [t.get('name') for t in body.get('tools', [])],
                        'inputBytes': len(json.dumps(body.get('input', body.get('messages', []))).encode())})
                    if number:
                        try:
                            evidence['modelRequests'][-1]['latestToolOutput'] = trim_images(latest_tool_output(body, host))
                            if host == 'codex':
                                outputs = [v for v in body.get('input', []) if isinstance(v, dict) and v.get('type') == 'function_call_output']
                                output_id = outputs[-1].get('call_id')
                            else:
                                outputs = [c for m in body.get('messages', []) for c in m.get('content', [])
                                           if isinstance(c, dict) and c.get('type') == 'tool_result']
                                output_id = outputs[-1].get('tool_use_id')
                            evidence['modelRequests'][-1]['latestToolOutputId'] = output_id
                        except Exception:
                            evidence['modelRequests'][-1]['latestToolOutput'] = 'absent'
                    if number > len(sequence):
                        raise RuntimeError('Unexpected extra model request')
                    try:
                        host_event = None
                        if host == 'codex' and number == 6:
                            deadline = time.monotonic() + 2
                            while time.monotonic() < deadline:
                                host_event = next((event for event in evidence['hostEvents'] if event.get('id') == 'callid_5'), None)
                                if host_event:
                                    break
                                time.sleep(0.01)
                            evidence['observationDelivery'] = 'Actual Codex app-server MCP completion event'
                            image_nodes = [node for node in expanded(body.get('input', [])) if isinstance(node, dict) and node.get('type') in ('input_image', 'image', 'image_url')]
                            evidence['modelImageNodeCount'] = len(image_nodes)
                            evidence['modelImageForwarding'] = ('not measured: image absent from this mock-provider request' if not image_nodes else 'not measured: only the native host event image was validated')
                        elif host == 'claude' and number == 6:
                            evidence['observationDelivery'] = 'Actual Claude CLI model request tool result image'
                        name, arguments, delivered_image = next_call(body, host, number, sequence, evidence['brokerCalls'], host_event)
                        if number:
                            evidence['deliveryChecks'].append({'step': number, 'matched': True})
                        if delivered_image:
                            assert jpeg_dimensions(delivered_image) == (1280, 800)
                            image_path.write_bytes(delivered_image)
                            evidence['observationArtifact'] = str(image_path)
                        if name == 'orbit_stop':
                            witnesses.extend(process_tree(broker.pid))
                    except Exception as error:
                        evidence['deliveryError'] = str(error)
                        name, arguments = None, {}
                    payload = (responses_stream(number, name, arguments) if host == 'codex'
                               else anthropic_stream(number, name, arguments))
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args):
                pass

        def serve(server):
            servers.append(server)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            workers.append(worker)
            worker.start()
            return server

        fixture = serve(http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture))
        origin = f'http://127.0.0.1:{fixture.server_port}'
        marker = 'orbit-disposable-host-input'
        create = {'backend': 'browser'}
        sequence = [('orbit_create', create),
                    ('orbit_act', {'requestId': 'navigate', 'action': {'type': 'navigate', 'url': origin}}),
                    ('orbit_act', {'requestId': 'fill', 'action': {'type': 'fill', 'selector': '#value', 'text': marker}}),
                    ('orbit_act', {'requestId': 'click', 'action': {'type': 'click', 'selector': '#submit'}}),
                    ('orbit_act', {'requestId': 'read', 'action': {'type': 'read', 'selector': '#result'}}),
                    ('orbit_observe', {}), ('orbit_stop', {})]
        relay = serve(socketserver.ThreadingUnixStreamServer(str(relay_path), Relay))
        model = serve(http.server.ThreadingHTTPServer(('127.0.0.1', 0), Model))
        try:
            with (root / 'broker.log').open('wb') as broker_log, (root / 'host.log').open('wb') as host_log:
                broker = subprocess.Popen([bun, str(PROJECT / 'experiments/host-action-acceptance-broker.ts'),
                                           str(broker_path), str(root / 'accounts')],
                    cwd=root / 'work', env=env, stdin=subprocess.PIPE, stdout=broker_log,
                    stderr=subprocess.STDOUT, start_new_session=True)
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    if broker.poll() is not None:
                        raise RuntimeError('Broker exited: ' + (root / 'broker.log').read_text()[-1500:])
                    if broker_path.exists():
                        status, ready = rpc_call(broker_path, 'session.list')
                        if status == 200 and ready.get('ok'):
                            break
                    time.sleep(0.05)
                else:
                    raise TimeoutError('Broker startup')
                adapter = {'command': bun, 'args': [str(PROJECT / 'src/mcp.ts')],
                           'env': {'ORBIT_SOCKET': str(relay_path), 'ORBIT_USAGE_DIR': str(root / 'usage')}}
                if host == 'codex':
                    env['MOCK_API_KEY'] = 'disposable-key'
                    (root / 'codex/config.toml').write_text('model = "gpt-5.1"\nmodel_provider = "mock"\nweb_search = "disabled"\n[model_providers.mock]\nname = "Local fixture"\nenv_key = "MOCK_API_KEY"\nwire_api = "responses"\nsupports_websockets = false\n' + f'base_url = "http://127.0.0.1:{model.server_port}/v1"\n')
                    evidence['launcher']['argv'] = [launcher, 'app-server', '--listen', 'stdio://']
                    app = subprocess.Popen(evidence['launcher']['argv'], cwd=root / 'work',
                        env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=host_log, start_new_session=True)
                    rpc = JsonRpc(app, evidence['hostEvents'])
                    rpc.call(1, 'initialize', {'clientInfo': {'name': 'orbit-acceptance', 'version': '1'},
                             'capabilities': {'experimentalApi': True}})
                    rpc.send('initialized')
                    thread = rpc.call(2, 'thread/start', {'ephemeral': True, 'cwd': str(root / 'work'),
                        'model': 'gpt-5.1', 'modelProvider': 'mock', 'approvalPolicy': 'never',
                        'sandbox': 'danger-full-access', 'config': {'mcp_servers': {'orbit': {**adapter, 'enabled_tools': ['orbit_create', 'orbit_act', 'orbit_observe', 'orbit_stop']}}}})['thread']
                    rpc.call(3, 'turn/start', {'threadId': thread['id'], 'input': [{'type': 'text', 'text': 'Run the disposable Orbit fixture actions.'}]})
                    deadline = time.monotonic() + 45
                    while time.monotonic() < deadline:
                        rpc.pump()
                        completed = [m for m in rpc.messages if m.get('method') == 'turn/completed']
                        if completed:
                            evidence['turnStatus'] = completed[-1]['params']['turn']['status']
                            break
                    else:
                        raise TimeoutError('Codex turn')
                    evidence['hostEvents'] = [m['params']['item'] for m in rpc.messages
                        if m.get('method') == 'item/completed' and m.get('params', {}).get('item', {}).get('type') == 'mcpToolCall']
                elif host == 'claude':
                    env.update({'ANTHROPIC_API_KEY': 'disposable-key',
                                'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{model.server_port}',
                                'ENABLE_TOOL_SEARCH': 'false'})
                    config = root / 'mcp.json'
                    config.write_text(json.dumps({'mcpServers': {'orbit': adapter}}))
                    host_argv = [launcher, '--bare', '--print', '--verbose', '--output-format', 'stream-json',
                        '--model', 'claude-sonnet-4-6', '--strict-mcp-config', '--mcp-config', str(config),
                        '--tools', '', '--allowedTools', 'mcp__orbit__*', '--max-turns', '10',
                        '--no-session-persistence', 'Run the disposable Orbit fixture actions.']
                    evidence['launcher']['argv'] = host_argv
                    app = subprocess.Popen(host_argv,
                        cwd=root / 'work', env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                        stderr=host_log, start_new_session=True)
                    out, _ = app.communicate(timeout=45)
                    evidence['hostExit'] = app.returncode
                    events = [json.loads(line) for line in out.decode().splitlines() if line.startswith('{')]
                    # Retain tool/result envelopes; trim image data below before saving.
                    evidence['hostEvents'] = events
                    if app.returncode:
                        raise RuntimeError('Claude failed: ' + out.decode()[-1200:] + (root / 'host.log').read_text()[-1200:])
                elif host in ('api', 'cli'):
                    if host == 'cli':
                        evidence['cliSource'] = {'path': str(PROJECT / 'src/cli.ts'),
                            'sha256': hashlib.sha256((PROJECT / 'src/cli.ts').read_bytes()).hexdigest()}
                    sid = None
                    for index, (name, arguments) in enumerate(sequence):
                        if index:
                            arguments = {**arguments, 'sessionId': sid}
                        method = {'orbit_create': 'session.create', 'orbit_act': 'session.act',
                                  'orbit_observe': 'session.observe', 'orbit_stop': 'session.stop'}[name]
                        if name == 'orbit_stop':
                            witnesses.extend(process_tree(broker.pid))
                        if host == 'api':
                            status, body = rpc_call(relay_path, method, arguments)
                            assert status == 200 and body.get('ok'), body
                        else:
                            verb = method.split('.')[1]
                            argv = ([launcher, str(PROJECT / 'src/cli.ts'), 'act', sid, json.dumps(arguments['action'])]
                                    if name == 'orbit_act' else
                                    [launcher, str(PROJECT / 'src/cli.ts'), 'session', verb, 'browser' if index == 0 else sid])
                            child_env = {**env, 'ORBIT_REQUEST_ID': arguments.get('requestId', 'cli-create')}
                            child = subprocess.Popen(argv, cwd=root / 'work', env=child_env,
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                start_new_session=True)
                            try:
                                out, err = child.communicate(timeout=15)
                            finally:
                                stop(child)
                            stdout_path = image_path.with_suffix(f'.step-{index}.stdout')
                            stdout_path.write_bytes(out)
                            evidence.setdefault('cliOutput', []).append({'step': index, 'argv': argv[2:],
                                'invocation': argv, 'requestId': child_env['ORBIT_REQUEST_ID'],
                                'exit': child.returncode, 'stdoutBytes': len(out),
                                'stdoutSha256': hashlib.sha256(out).hexdigest(), 'path': str(stdout_path),
                                'stderr': err.decode()[:500]})
                            assert child.returncode == 0, (out.decode(), err.decode())
                            body = json.loads(out)
                            assert body.get('ok'), body
                            evidence['hostEvents'].append({'argv': argv[2:], 'response': summarize(body['result'])})
                        if index == 0:
                            sid = body['result']['sessionId']
                        if name == 'orbit_observe':
                            delivered_image = base64.b64decode(body['result']['image'], validate=True)
                            assert jpeg_dimensions(delivered_image) == (1280, 800)
                            image_path.write_bytes(delivered_image)
                            evidence['observationArtifact'] = str(image_path)
                        if index == 3:
                            deadline = time.monotonic() + 2
                            while not evidence['submissions'] and time.monotonic() < deadline:
                                time.sleep(0.01)
                else:
                    raise ValueError('Unsupported host')
                assert not evidence.get('deliveryError'), evidence.get('deliveryError')
                if host in ('codex', 'claude'):
                    assert len(evidence['deliveryChecks']) == 7, evidence['deliveryChecks']
                if host == 'codex':
                    assert evidence['turnStatus'] == 'completed', evidence['turnStatus']
                    assert [e['tool'] for e in evidence['hostEvents']] == [n for n, _ in sequence]
                    assert all(e['status'] == 'completed' and not e.get('error') for e in evidence['hostEvents'])
                if host == 'claude':
                    terminal = [e for e in evidence['hostEvents'] if e.get('type') == 'result']
                    assert len(terminal) == 1 and terminal[0].get('subtype') == 'success' and not terminal[0].get('is_error'), terminal
                    uses = [c for e in evidence['hostEvents'] if e.get('type') == 'assistant'
                            for c in e.get('message', {}).get('content', []) if c.get('type') == 'tool_use']
                    assert [e['name'] for e in uses] == ['mcp__orbit__' + n for n, _ in sequence], uses
                calls = evidence['brokerCalls']
                assert [c['method'] for c in calls] == ['session.create'] + ['session.act'] * 4 + ['session.observe', 'session.stop'], calls
                assert all(c['response'].get('ok') for c in calls), calls
                assert calls[4]['response']['result'] == {'text': marker}, calls[4]
                assert evidence['submissions'] == [marker], evidence['submissions']
                image = calls[5]['response']['result']
                assert image['imageBytes'] > 0 and image['width'] == 1280 and image['height'] == 800, image
                assert image['presence']['title'] == 'Orbit host acceptance', image
                sid = calls[0]['response']['result']['sessionId']
                status, sessions = rpc_call(broker_path, 'session.list')
                assert status == 200 and sessions.get('ok') and len(sessions['result']) == 1 and sessions['result'][0]['state'] == 'closed', sessions
                status, stale = rpc_call(broker_path, 'session.presence', {'sessionId': sid})
                assert not stale.get('ok'), stale
                evidence['postStop'] = {'sessions': sessions, 'stale': stale}
                assert witnesses, 'No owned descendants witnessed before stop'
                deadline = time.monotonic() + 5
                while alive_witnesses(witnesses) and time.monotonic() < deadline:
                    time.sleep(0.05)
                evidence['ownedProcessWitnesses'] = witnesses
                evidence['survivorsAfterStop'] = alive_witnesses(witnesses)
                assert not evidence['survivorsAfterStop'], evidence['survivorsAfterStop']
                evidence['state'] = 'passed'
        except Exception as error:
            evidence['error'] = str(error)
        finally:
            stop(app)
            if broker and broker.poll() is None:
                # Explicit cleanup of every disposable session, including failed host calls.
                try:
                    _, sessions = rpc_call(broker_path, 'session.list')
                    for session in sessions.get('result', []):
                        rpc_call(broker_path, 'session.stop', {'sessionId': session['sessionId']})
                except Exception:
                    pass
                broker.stdin.close()
                try:
                    broker.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
            stop(broker)
            evidence['cleanupSurvivors'] = alive_witnesses(witnesses)
            if evidence['cleanupSurvivors']:
                evidence['state'] = 'failed'
                evidence['error'] = 'Owned descendants survived cleanup'
            for server in reversed(servers):
                server.shutdown()
                server.server_close()
            for worker in workers:
                worker.join(timeout=2)
            evidence['sourceUnchanged'] = source_identity() == evidence['source']
            if not evidence['sourceUnchanged']:
                evidence['state'] = 'failed'
                evidence['error'] = 'Source changed during measurement'
    evidence['privateRootRemoved'] = not root.exists()
    if not evidence['privateRootRemoved']:
        evidence['state'] = 'failed'
        evidence['error'] = 'Private root was not removed'
    return evidence


def trim_images(value):
    if isinstance(value, list):
        return [trim_images(v) for v in value]
    if isinstance(value, dict):
        return {k: ({'bytes': len(v), 'sha256': hashlib.sha256(v.encode()).hexdigest()}
                    if k in ('data', 'image', 'image_url') and isinstance(v, str) and len(v) > 1024 else trim_images(v))
                for k, v in value.items()}
    return value


if __name__ == '__main__':
    def interrupted(_signum, _frame):
        raise TimeoutError('Probe interrupted; cleaning owned process groups')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('host', choices=['codex', 'claude', 'api', 'cli'])
    parser.add_argument('--launcher', help='Actual installed launcher, defaults to PATH discovery')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    launcher = args.launcher or (shutil.which(args.host) if args.host in ('codex', 'claude') else shutil.which('bun'))
    if not launcher:
        result = {'host': args.host, 'state': 'not measured', 'reason': 'Installed launcher absent'}
    else:
        result = trim_images(run(args.host, launcher, args.output.with_suffix('.jpg')))
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + '\n')
    print(json.dumps({'host': args.host, 'state': result['state'], 'output': str(args.output),
                      'error': result.get('error'), 'brokerCalls': len(result.get('brokerCalls', []))}))
    raise SystemExit(0 if result['state'] == 'passed' else 1)
