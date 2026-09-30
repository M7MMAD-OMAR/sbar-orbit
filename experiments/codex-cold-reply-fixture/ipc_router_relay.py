#!/usr/bin/python3
"""Record framed IPC methods while relaying between two disposable Desktops."""

import asyncio
import json
from collections import Counter
from pathlib import Path

MAX_FRAME = 16 * 1024 * 1024


class DisposableIpcRouterRelay:
 def __init__(self, upstream: Path, listen: Path, pinned_thread: str | None = None):
  self.upstream = upstream
  self.listen = listen
  self.pinned_thread = pinned_thread
  self.server = None
  self.methods = Counter()
  self.denied = Counter()
  self.connections = 0

 async def start(self):
  self.server = await asyncio.start_unix_server(self._accept, path=str(self.listen))
  self.listen.chmod(0o600)
  return self

 async def close(self):
  if self.server is not None:
   self.server.close()
   await self.server.wait_closed()
  self.listen.unlink(missing_ok=True)

 def summary(self):
  return {'connections': self.connections, 'methods': dict(sorted(self.methods.items())),
          'denied': dict(sorted(self.denied.items()))}

 async def _accept(self, downstream_reader, downstream_writer):
  self.connections += 1
  try:
   upstream_reader, upstream_writer = await asyncio.open_unix_connection(str(self.upstream))
  except OSError:
   downstream_writer.close()
   await downstream_writer.wait_closed()
   return

  assigned_client_id = None

  async def send(writer, message):
   body = json.dumps(message, separators=(',', ':')).encode()
   writer.write(len(body).to_bytes(4, 'little') + body)
   await writer.drain()

  async def pump(reader, writer, direction):
   nonlocal assigned_client_id
   try:
    while True:
     header = await reader.readexactly(4)
     size = int.from_bytes(header, 'little')
     if size < 1 or size > MAX_FRAME:raise ValueError('invalid disposable IPC frame size')
     body = await reader.readexactly(size)
     message = json.loads(body)
     if not isinstance(message, dict):raise ValueError('invalid disposable IPC message')
     kind = message.get('type')
     method = message.get('method')
     if isinstance(kind, str):
      self.methods[f'{direction}:{kind}:{method if isinstance(method,str) else "none"}'] += 1
     if self.pinned_thread is not None:
      params = message.get('params')
      params = params if isinstance(params, dict) else {}
      if direction == 'client':
       if kind == 'client-discovery-response':
        request_id = message.get('requestId')
        if isinstance(request_id, str):
         await send(upstream_writer, {'type':'client-discovery-response','requestId':request_id,
                                      'response':{'canHandle':False}})
        self.denied['client:claim-owner'] += 1
        continue
       if kind == 'request' and method == 'initialize' and assigned_client_id is None:
        pass
       elif (kind == 'broadcast' and method == 'thread-stream-following-changed'
             and message.get('sourceClientId') == assigned_client_id
             and assigned_client_id is not None
             and params.get('conversationId') == self.pinned_thread
             and params.get('hostId') == 'local'
             and isinstance(params.get('following'), bool)
             and message.get('targetClientIds') is None):
        pass
       else:
        self.denied[f'client:{kind}:{method if isinstance(method,str) else "none"}'] += 1
        if kind == 'request' and isinstance(message.get('requestId'), str):
         await send(downstream_writer, {'type':'response','requestId':message['requestId'],
                                        'method':method,'resultType':'error','error':'denied'})
        continue
      else:
       if kind == 'client-discovery-request':
        request_id = message.get('requestId')
        if isinstance(request_id, str):
         await send(upstream_writer, {'type':'client-discovery-response','requestId':request_id,
                                      'response':{'canHandle':False}})
        self.denied['owner:discovery-to-follower'] += 1
        continue
       if kind == 'response' and method == 'initialize':
        result = message.get('result')
        if isinstance(result, dict) and isinstance(result.get('clientId'), str):
         assigned_client_id = result['clientId']
       elif (kind == 'broadcast' and method in ('thread-stream-state-changed',
                                                'thread-stream-following-changed')
             and params.get('conversationId') == self.pinned_thread
             and params.get('hostId') == 'local'):
        pass
       else:
        self.denied[f'owner:{kind}:{method if isinstance(method,str) else "none"}'] += 1
        continue
     writer.write(header + body)
     await writer.drain()
   except (asyncio.IncompleteReadError, ConnectionError, ValueError, json.JSONDecodeError):
    pass
   finally:
    writer.close()

  try:
   await asyncio.gather(pump(downstream_reader, upstream_writer, 'client'),
                        pump(upstream_reader, downstream_writer, 'owner'))
  finally:
   downstream_writer.close()
   upstream_writer.close()
   await asyncio.gather(downstream_writer.wait_closed(), upstream_writer.wait_closed(), return_exceptions=True)
