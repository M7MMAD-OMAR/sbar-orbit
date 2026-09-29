#!/usr/bin/python3
import asyncio, base64, ctypes, datetime, http.client, json, os, secrets, shutil, signal, socket, sqlite3, stat, subprocess, sys, time, uuid
from pathlib import Path
import websockets
ROOT=Path(sys.argv[1]).resolve(); assert ROOT.parent==Path('/var/tmp') and ROOT.name.startswith('codex-private-smoke-')
RESTRICT_TOOLS='--restrict-tools' in sys.argv[3:]
ORBIT_TOOL='--orbit-tool' in sys.argv[3:]
REAL_ORBIT='--real-orbit-tool' in sys.argv[3:]
RESTART_OWNER='--restart-owner' in sys.argv[3:]
PUBLIC_ATTACH='--public-attach' in sys.argv[3:]
FOOTER_ONLY='--footer-only' in sys.argv[3:]
DIRECT_ONLY='--direct-only' in sys.argv[3:]
assert sum([RESTRICT_TOOLS,ORBIT_TOOL,REAL_ORBIT])<=1
PERSONAL_HOME=Path.home()
ORBIT_REPO=Path(sys.argv[2]).resolve()
assert (ORBIT_REPO/'src/native/supervise.py').is_file()
APP=ROOT/'app/ChatGPT'; UID=os.getuid(); AUTH_DIR=Path(f'/run/user/{UID}')/('orbit-codex-smoke-'+uuid.uuid4().hex[:8]); APP_SOCKET=AUTH_DIR/'app-server.sock'; STATE_SOCKET=Path(str(APP_SOCKET)+'.state')
TAG=uuid.uuid4().hex[:8]; OWNER=ROOT/f'owner-codex-orbit-{TAG}'; CLIENT=ROOT/f'client-codex-orbit-{TAG}'; PROJECT=ROOT/f'workspace-orbit-{TAG}'; PROJECT_ID=str(uuid.uuid4())
FAKE_EMAIL='orbit-owner' + chr(64) + 'fixture.invalid'

def fake_jwt(payload):
 def encoded(value):
  return base64.urlsafe_b64encode(json.dumps(value,separators=(',',':')).encode()).decode().rstrip('=')
 return encoded({'alg':'none','typ':'JWT'})+'.'+encoded(payload)+'.fixture'

def stop(p):
 if p is None or p.poll() is not None:return
 try:os.killpg(p.pid,signal.SIGTERM);p.wait(timeout=5)
 except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
 except ProcessLookupError:pass

def dirs(role,name):return ROOT/(name+f'-orbit-{TAG}-'+('owner' if role==1 else 'client'))

def ns(display,role):
 home=dirs(role,'home');runtime=dirs(role,'runtime');tmp=dirs(role,'tmp');user=dirs(role,'user-data')
 for p in [home,runtime,tmp,user,dirs(role,'config'),dirs(role,'data'),dirs(role,'cache')]:p.mkdir(mode=0o700,exist_ok=True)
 (runtime/AUTH_DIR.name).mkdir(mode=0o700,exist_ok=True)
 placeholder=tmp/'.X11-unix'/f'X{display}';placeholder.parent.mkdir(parents=True,exist_ok=True);placeholder.touch(exist_ok=True)
 codex=OWNER if role==1 else CLIENT
 args=['bwrap','--unshare-user','--unshare-pid','--unshare-net','--unshare-ipc','--unshare-uts','--die-with-parent','--ro-bind','/','/','--bind',str(ROOT),str(ROOT)]
 if REAL_ORBIT:args.extend(['--ro-bind',str(ORBIT_REPO),str(ROOT/'orbit-repo')])
 args.extend(['--bind',str(home),str(PERSONAL_HOME),'--bind',str(runtime),f'/run/user/{UID}','--bind',str(AUTH_DIR),str(AUTH_DIR),'--bind',str(tmp),'/tmp','--bind',f'/tmp/.X11-unix/X{display}',f'/tmp/.X11-unix/X{display}','--dev','/dev','--proc','/proc','--','/usr/bin/env','-i',f'HOME={home}',f'CODEX_HOME={codex}',f'XDG_CONFIG_HOME={dirs(role,"config")}',f'XDG_DATA_HOME={dirs(role,"data")}',f'XDG_CACHE_HOME={dirs(role,"cache")}',f'XDG_RUNTIME_DIR={runtime}',f'TMPDIR={tmp}',f'XAUTHORITY={ROOT/"xauth"}',f'DISPLAY=:{display}','XDG_SESSION_TYPE=x11','GSETTINGS_BACKEND=dconf',f'CODEX_ELECTRON_USER_DATA_PATH={user}',f'CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET={APP_SOCKET}',f'CODEX_LINUX_APP_DIR={ROOT/"app"}',f'CODEX_CLI_PATH={ROOT/"app/resources/codex"}','PATH=/usr/bin:/bin','LANG=C.UTF-8'])
 if role==2:args.extend(['CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY=1',f'CODEX_LINUX_APP_SERVER_BRIDGE_PRIVATE_CODEX_HOME={CLIENT}'])
 return args

def state_req(method,params=None):
 s=socket.socket(socket.AF_UNIX);s.settimeout(5);s.connect(str(STATE_SOCKET));s.sendall((json.dumps({'id':1,'method':method,'params':params or {}})+'\n').encode());data=b''
 while b'\n' not in data:data+=s.recv(65536)
 s.close();return json.loads(data.split(b'\n')[0])

class BrokerConnection(http.client.HTTPConnection):
 def __init__(self,path):super().__init__('localhost',timeout=30);self.path=path
 def connect(self):
  self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(self.timeout);self.sock.connect(self.path)

def broker_call(path,method,params=None):
 c=BrokerConnection(str(path))
 try:
  c.request('POST','/rpc',json.dumps({'method':method,'params':params or {}}),{'Content-Type':'application/json'})
  response=c.getresponse();body=json.loads(response.read())
  if response.status!=200 or not body.get('ok'):raise RuntimeError(f'{method} failed: {body}')
  return body['result']
 finally:c.close()

def wait_for_broker(path,child):
 for _ in range(300):
  if child.poll() is not None:raise RuntimeError('disposable Orbit broker exited')
  if path.exists():
   try:broker_call(path,'session.list');return
   except OSError:pass
  time.sleep(.1)
 raise RuntimeError('disposable Orbit broker did not start')

async def rpc(ws,i,method,params):
 await ws.send(json.dumps({'id':i,'method':method,'params':params}))
 while True:
  item=json.loads(await asyncio.wait_for(ws.recv(),10))
  if item.get('id')==i:return item

def private_click(display,x,y):
 code=("import ctypes; x=ctypes.CDLL('libX11.so.6');t=ctypes.CDLL('libXtst.so.6');"
       "x.XOpenDisplay.restype=ctypes.c_void_p;x.XOpenDisplay.argtypes=[ctypes.c_char_p];d=x.XOpenDisplay(None);assert d;"
       "t.XTestFakeMotionEvent.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_ulong];"
       "t.XTestFakeButtonEvent.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_int,ctypes.c_ulong];"
       f"t.XTestFakeMotionEvent(d,-1,{x},{y},0);t.XTestFakeButtonEvent(d,1,1,0);t.XTestFakeButtonEvent(d,1,0,0);"
       "x.XFlush.argtypes=[ctypes.c_void_p];x.XFlush(d)")
 r=subprocess.run(ns(display,2)+['/usr/bin/python3','-c',code],capture_output=True,text=True,timeout=10)
 if r.returncode:raise RuntimeError('private click failed: '+r.stderr[-500:])

def private_owner_quit(wrapper_pid):
 pending=[wrapper_pid];seen=set();parents={}
 while pending:
  pid=pending.pop()
  if pid in seen:continue
  seen.add(pid)
  try:
   for child in Path(f'/proc/{pid}/task/{pid}/children').read_text().split():
    child_pid=int(child);parents[child_pid]=pid;pending.append(child_pid)
  except (OSError,ValueError):continue
 matches=[]
 for pid in seen:
  entry=Path(f'/proc/{pid}')
  try:
   if not os.path.samefile(entry/'exe',APP):continue
   argv=(entry/'cmdline').read_bytes().decode(errors='replace').split('\0')
  except (OSError,PermissionError):continue
  matches.append(pid)
 candidate_set=set(matches)
 main=[]
 for pid in matches:
  ancestor=parents.get(pid)
  while ancestor is not None and ancestor not in candidate_set:ancestor=parents.get(ancestor)
  if ancestor is None:main.append(pid)
 if len(main)!=1:raise RuntimeError(f'Expected one disposable owner Desktop main process, found {len(main)} among {len(matches)}')
 os.kill(main[0],signal.SIGTERM)

async def main():
 assert APP.is_file() and not APP.is_symlink() and not os.path.samefile(APP,'/usr/lib/chatgpt/ChatGPT')
 assert not os.path.samefile(ROOT/'app/resources/app.asar','/usr/lib/chatgpt/resources/app.asar')
 OWNER.mkdir(mode=0o700,exist_ok=True);CLIENT.mkdir(mode=0o700,exist_ok=True);PROJECT.mkdir(mode=0o700,exist_ok=True);APP_SOCKET.parent.mkdir(mode=0o700)
 (PROJECT/'fixture.txt').write_text('Disposable Codex project for private Orbit evidence.\n')
 mock_wrapper=ROOT/f'mock-owner-desktop-{TAG}.py';shutil.copyfile(Path(__file__).with_name('mock-owner-desktop.py'),mock_wrapper)
 toy_mcp=ROOT/f'toy-orbit-mcp-{TAG}.py'
 if ORBIT_TOOL:shutil.copyfile(Path(__file__).with_name('toy-orbit-mcp.py'),toy_mcp)
 toy_action_record=ROOT/f'toy-action-{TAG}.json'
 if REAL_ORBIT:
  (ROOT/'orbit-repo').mkdir(mode=0o700)
  bun_source=shutil.which('bun')
  if not bun_source:raise RuntimeError('Bun is required for the disposable Orbit MCP adapter')
  bun_runtime=ROOT/f'bun-orbit-{TAG}'
  shutil.copyfile(bun_source,bun_runtime);bun_runtime.chmod(0o700)
  broker_socket=ROOT/f'broker-{TAG}.sock'
 now=int(time.time()*1000)
 (OWNER/'.codex-global-state.json').write_text(json.dumps({'local-projects':{PROJECT_ID:{'id':PROJECT_ID,'name':'Shared Fixture Project','rootPaths':[str(PROJECT)],'createdAt':now,'updatedAt':now}},'project-order':[PROJECT_ID]}))
 (OWNER/'config.toml').write_text('model = "gpt-5.1"\nmodel_provider = "mock"\nweb_search = "disabled"\nchatgpt_base_url = "http://127.0.0.1:43837/backend-api/"\n[model_providers.mock]\nname = "Local Mock"\nrequires_openai_auth = true\nbase_url = "http://127.0.0.1:43837/v1"\nenv_key = "MOCK_API_KEY"\nwire_api = "responses"\nsupports_websockets = false\n')
 pref=dirs(2,'config')/'dconf';pref.mkdir(parents=True,exist_ok=True)
 keyfiles=ROOT/f'orbit-keyfiles-{TAG}';keyfiles.mkdir(exist_ok=True)
 (keyfiles/'prefs').write_text("[org/gnome/desktop/interface]\ncolor-scheme='prefer-dark'\ngtk-theme='adw-gtk3-dark'\n")
 subprocess.run(['dconf','compile',str(pref/'user'),str(keyfiles)],check=True)
 check=subprocess.run(['/usr/bin/env','-i',f'XDG_CONFIG_HOME={dirs(2,"config")}','GSETTINGS_BACKEND=dconf','gsettings','get','org.gnome.desktop.interface','color-scheme'],capture_output=True,text=True,check=True)
 assert check.stdout.strip()=="'prefer-dark'"
 claims={'exp':int(time.time())+86400,'iat':int(time.time()),'sub':'fixture-user',
         'https://api.openai.com/profile':{'email':FAKE_EMAIL,'name':'Orbit Fixture Owner'},
         'https://api.openai.com/auth':{'chatgpt_user_id':'fixture-user','user_id':'fixture-user','chatgpt_plan_type':'plus'}}
 jwt=fake_jwt(claims)
 owner_auth={'auth_mode':'chatgpt','tokens':{'id_token':jwt,'access_token':jwt,
              'refresh_token':'fixture-refresh-unusable','account_id':'fixture_selected'},
             'last_refresh':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 auth_path=OWNER/'auth.json';auth_path.write_text(json.dumps(owner_auth));auth_path.chmod(0o600)
 displays=[i for i in range(170,230) if not Path(f'/tmp/.X11-unix/X{i}').exists() and not Path(f'/tmp/.X{i}-lock').exists()][:1]
 if len(displays)!=1:raise RuntimeError('one free display required')
 for display in displays:subprocess.run(['xauth','-f',str(ROOT/'xauth'),'add',f':{display}','MIT-MAGIC-COOKIE-1',secrets.token_hex(16)],check=True,capture_output=True)
 (ROOT/'xauth').chmod(0o600)
 xservers=[];desktops=[];logs=[];broker=None;real_session=None
 try:
  if REAL_ORBIT:
   broker_home=ROOT/f'broker-home-{TAG}';broker_runtime=ROOT/f'broker-runtime-{TAG}'
   broker_home.mkdir(mode=0o700);broker_runtime.mkdir(mode=0o700)
   broker_env={'HOME':str(broker_home),'XDG_RUNTIME_DIR':str(broker_runtime),
    'XDG_CONFIG_HOME':str(broker_home/'config'),'XDG_DATA_HOME':str(broker_home/'data'),
    'XDG_CACHE_HOME':str(broker_home/'cache'),'XDG_STATE_HOME':str(broker_home/'state'),
    'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','HTTP_PROXY':'http://127.0.0.1:9',
    'HTTPS_PROXY':'http://127.0.0.1:9','ALL_PROXY':'http://127.0.0.1:9',
    'NO_PROXY':'127.0.0.1,localhost'}
   broker_log=(ROOT/f'broker-{TAG}.log').open('wb');logs.append(broker_log)
   broker=subprocess.Popen([bun_source,str(ORBIT_REPO/'experiments/codex-real-broker-fixture.ts'),
    str(broker_socket),str(ROOT/f'accounts-{TAG}')],cwd=str(ROOT),env=broker_env,
    stdin=subprocess.PIPE,stdout=broker_log,stderr=subprocess.STDOUT,start_new_session=True)
   wait_for_broker(broker_socket,broker)
   created=broker_call(broker_socket,'session.create',{'backend':'fedora','agentName':'Codex fixture',
    'taskName':'Private Codex MCP pointer','policy':{'mode':'autonomous','allow':['read','write']}})
   real_session=created['sessionId']
   if broker_call(broker_socket,'session.presence',{'sessionId':real_session}).get('pointer') is not None:
    raise RuntimeError('disposable Orbit pointer was not initially empty')
  for display in displays:
   f=(ROOT/f'xvnc-{display}.log').open('wb');logs.append(f)
   xservers.append(subprocess.Popen(['Xvnc',f':{display}','-geometry','1280x800','-depth','24','-nolisten','tcp','-localhost','-SecurityTypes','None','-rfbunixpath',str(ROOT/f'vnc-{display}.sock'),'-auth',str(ROOT/'xauth')],stdin=subprocess.DEVNULL,stdout=f,stderr=subprocess.STDOUT,start_new_session=True))
  for display,p in zip(displays,xservers):
   for _ in range(100):
    if Path(f'/tmp/.X11-unix/X{display}').is_socket():break
    if p.poll() is not None:raise RuntimeError('private display failed')
    await asyncio.sleep(.05)
  for role,display in enumerate(displays,1):
   code="import pathlib,os; p=pathlib.Path;assert not p('%s/.codex').exists();assert not p('/tmp/codex-ipc').exists();assert not p('/run/user/%s/bus').exists();assert sorted(x.name for x in p('/tmp/.X11-unix').iterdir())==['X%s']"%(str(PERSONAL_HOME),UID,display)
   r=subprocess.run(ns(display,role)+['/usr/bin/python3','-c',code],capture_output=True,text=True,timeout=10)
   if r.returncode:raise RuntimeError('isolation failed: '+r.stderr[-500:])
  def launch(role,display):
   f=(ROOT/f'desktop-dconf-only-{role}.log').open('wb');logs.append(f)
   env=ns(display,role)
   if role==1:
    env.insert(env.index('PATH=/usr/bin:/bin'),'MOCK_API_KEY=fixture-only')
    env.insert(env.index('PATH=/usr/bin:/bin'),f'ORBIT_MODEL_RECORD={ROOT/f"model-tools-{TAG}.json"}')
    if RESTRICT_TOOLS:env.insert(env.index('PATH=/usr/bin:/bin'),'ORBIT_EXPECT_EMPTY_TOOLS=1')
    if ORBIT_TOOL:env.insert(env.index('PATH=/usr/bin:/bin'),'ORBIT_EXPECT_ORBIT_TOOL=1')
    if REAL_ORBIT:env.insert(env.index('PATH=/usr/bin:/bin'),'ORBIT_EXPECT_REAL_ORBIT=1')
   command=['/usr/bin/dbus-run-session','--',str(APP),'--no-sandbox','--disable-gpu','--password-store=basic',f'--user-data-dir={dirs(role,"user-data")}']
   if role==1:command=['/usr/bin/python3',str(mock_wrapper),*command]
   p=subprocess.Popen(env+command,stdin=subprocess.DEVNULL,stdout=f,stderr=subprocess.STDOUT,start_new_session=True)
   desktops.append(p);return p
  first=launch(1,displays[0])
  for _ in range(250):
   if APP_SOCKET.is_socket() and STATE_SOCKET.is_socket():break
   if first.poll() is not None:raise RuntimeError('owner exited')
   await asyncio.sleep(.05)
  else:raise RuntimeError('owner sockets missing')
  owner_socket=APP_SOCKET.stat();owner_state=STATE_SOCKET.stat()
  hello=state_req('hello');projects=state_req('read',{'key':'local-projects'});order=state_req('read',{'key':'project-order'})
  if hello.get('result',{}).get('ownerCodexHome')!=str(OWNER):raise RuntimeError('owner home mismatch')
  if PROJECT_ID not in projects.get('result',{}):raise RuntimeError('owner project absent')
  if DIRECT_ONLY:
   async with websockets.unix_connect(str(APP_SOCKET),uri='ws://localhost/rpc',compression=None) as ws:
    await rpc(ws,1,'initialize',{'clientInfo':{'name':'fixture_account_probe','title':'Fixture account probe','version':'1'},'capabilities':{'experimentalApi':True}})
    await ws.send(json.dumps({'method':'initialized'}))
    status=await rpc(ws,2,'getAuthStatus',{'includeToken':False,'refreshToken':False})
    account=await rpc(ws,3,'account/read',{'refreshToken':False})
   identity=(account.get('result') or {}).get('account') or {}
   routing=(account.get('result') or {}).get('workspaceRouting') or {}
   result={'authMethod':(status.get('result') or {}).get('authMethod'),
           'accountType':identity.get('type'),'emailPresent':bool(identity.get('email')),
           'planPresent':bool(identity.get('planType')),
           'accountIdPresent':bool(routing.get('chatgptAccountId')),
           'statusErrorCode':(status.get('error') or {}).get('code'),
           'accountErrorCode':(account.get('error') or {}).get('code')}
   print(json.dumps(result),flush=True)
   if result['accountType']!='chatgpt' or not result['accountIdPresent'] or result['accountErrorCode'] is not None:
    raise RuntimeError('disposable account projection failed')
   return
  if not FOOTER_ONLY:
   async with websockets.unix_connect(str(APP_SOCKET),uri='ws://localhost/rpc',compression=None) as ws:
    await rpc(ws,1,'initialize',{'clientInfo':{'name':'state_smoke','title':'State smoke','version':'1'},'capabilities':{'experimentalApi':True}})
    await ws.send(json.dumps({'method':'initialized'}))
    thread_params={'cwd':str(PROJECT),'model':'gpt-5.1','modelProvider':'mock','approvalPolicy':'never','sandbox':'read-only'}
    if RESTRICT_TOOLS:thread_params['allowedTools']=[]
    if ORBIT_TOOL or REAL_ORBIT:
     thread_params['allowedTools']=[{'namespace':'mcp__orbit_private','name':'orbit_act'}]
     transport={'command':'/usr/bin/python3','args':['-u',str(toy_mcp)],
      'env':{'ORBIT_TOY_ACTION_RECORD':str(toy_action_record)}}
     if REAL_ORBIT:transport={'command':str(bun_runtime),
      'args':[str(ROOT/'orbit-repo/src/session-mcp.ts')],
      'env':{'ORBIT_SOCKET':str(broker_socket),'ORBIT_SESSION_ID':real_session,
       'ORBIT_USAGE_DIR':str(ROOT/f'usage-{TAG}')}}
     transport['default_tools_approval_mode']='approve'
     thread_params['config']={'features':{'plugins':False},'mcp_servers':{'orbit_private':transport}}
    started=await rpc(ws,2,'thread/start',thread_params)
    tid=started.get('result',{}).get('thread',{}).get('id')
    if not tid:raise RuntimeError('fixture thread not started')
    await rpc(ws,3,'turn/start',{'threadId':tid,'input':[{'type':'text','text':'Private fixture conversation'}]})
    for _ in range(400):
     turns=await rpc(ws,4,'thread/turns/list',{'threadId':tid,'limit':10})
     if any(turn.get('status')=='completed' for turn in turns.get('result',{}).get('data',[])):break
     model_record=ROOT/f'model-tools-{TAG}.json'
     if RESTRICT_TOOLS and model_record.is_file():
      exposed=json.loads(model_record.read_text()).get('toolCount')
      if exposed!=0:raise RuntimeError(f'restricted fixture exposed {exposed} model tools')
     await asyncio.sleep(.1)
    else:raise RuntimeError('fixture turn did not complete')
    read=await rpc(ws,5,'thread/read',{'threadId':tid,'includeTurns':True})
    if 'Orbit completed fixture answer' not in json.dumps(read):raise RuntimeError('fixture answer not persisted')
    model_record=ROOT/f'model-tools-{TAG}.json'
    if not model_record.is_file():raise RuntimeError('fixture model was not called')
    model_tools=json.loads(model_record.read_text())
    if RESTRICT_TOOLS and model_tools.get('toolCount')!=0:raise RuntimeError('restricted thread exposed model tools')
    if ORBIT_TOOL or REAL_ORBIT:
     requests=model_tools.get('requests',[])
     if len(requests)!=2 or requests[0].get('toolNames')!={'mcp__orbit_private':['orbit_act']} or not requests[1].get('toolResultSeen'):
      raise RuntimeError('positive tool inventory or result mismatch')
    if REAL_ORBIT:
     presence=broker_call(broker_socket,'session.presence',{'sessionId':real_session})
     journal=broker_call(broker_socket,'session.journal',{'sessionId':real_session})
     actions=[entry for entry in journal.get('entries',[]) if entry.get('actionType')=='pointer' and entry.get('outcome')=='allow']
     if presence.get('pointer')!={'x':317,'y':219} or len(actions)!=1:
      raise RuntimeError('real Orbit session did not record the private pointer action')
     print(json.dumps({'realOrbitSessionBound':True,'privatePointer':presence.get('pointer'),
      'brokerPointerActions':len(actions)}),flush=True)
    if ORBIT_TOOL:
     if not toy_action_record.is_file() or json.loads(toy_action_record.read_text()).get('requestId')!='positive-tool-fixture':
      raise RuntimeError('private toy Orbit action did not run')
    print(json.dumps({'restrictedTools':RESTRICT_TOOLS,'orbitTool':ORBIT_TOOL,'realOrbitTool':REAL_ORBIT,
     'modelToolCount':model_tools.get('toolCount'),'modelRequests':len(model_tools.get('requests',[])),
     'privateToyActionRan':toy_action_record.is_file()}),flush=True)
  async with websockets.unix_connect(str(APP_SOCKET),uri='ws://localhost/rpc',compression=None) as inspect_ws:
   await rpc(inspect_ws,30,'initialize',{'clientInfo':{'name':'fixture_identity_inspection','title':'Fixture identity inspection','version':'1'},'capabilities':{'experimentalApi':True}})
   await inspect_ws.send(json.dumps({'method':'initialized'}))
   account_response=await rpc(inspect_ws,31,'account/read',{'refreshToken':False})
   identity=account_response.get('result',{}).get('account') or {}
   routing=account_response.get('result',{}).get('workspaceRouting') or {}
   thread_response=await rpc(inspect_ws,32,'thread/list',{'limit':20,'useStateDbOnly':True})
   print(json.dumps({'ownerAccountType':identity.get('type'),'ownerPlan':identity.get('planType'),'ownerEmailPresent':bool(identity.get('email')),'ownerAccountId':routing.get('chatgptAccountId'),'ownerThreadCount':len((thread_response.get('result') or {}).get('data',[])),'ownerAccountError':(account_response.get('error') or {}).get('code')}),flush=True)
  saved_settings={key:started.get('result',{}).get(key) for key in
   ('model','modelProvider','cwd','approvalPolicy','sandbox','reasoningEffort')}
  old_owner_pid=first.pid;old_socket=owner_socket;old_state=owner_state
  private_owner_quit(first.pid)
  try:first.wait(timeout=15)
  except subprocess.TimeoutExpired:raise RuntimeError('owner did not quit from private fixture')
  first=launch(1,displays[0])
  for _ in range(250):
   if first.poll() is not None:raise RuntimeError('restarted owner exited')
   if APP_SOCKET.is_socket() and STATE_SOCKET.is_socket():
    current_socket=APP_SOCKET.stat();current_state=STATE_SOCKET.stat()
    if ((current_socket.st_dev,current_socket.st_ino)!=(old_socket.st_dev,old_socket.st_ino)
     and (current_state.st_dev,current_state.st_ino)!=(old_state.st_dev,old_state.st_ino)):
     try:
      hello=state_req('hello')
      if hello.get('result',{}).get('ownerCodexHome')==str(OWNER):break
     except (OSError,ValueError):pass
   await asyncio.sleep(.05)
  else:raise RuntimeError('owner authority did not restart with new sockets')
  owner_socket=APP_SOCKET.stat();owner_state=STATE_SOCKET.stat()
  if first.pid==old_owner_pid:raise RuntimeError('owner process identity did not change')
  async with websockets.unix_connect(str(APP_SOCKET),uri='ws://localhost/rpc',compression=None) as ws:
   await rpc(ws,60,'initialize',{'clientInfo':{'name':'orbit_owner_fixture','title':'Owner cold activation','version':'1'},'capabilities':{'experimentalApi':True}})
   await ws.send(json.dumps({'method':'initialized'}))
   cold=await rpc(ws,61,'thread/read',{'threadId':tid,'includeTurns':False,'readOnly':True})
   if cold.get('result',{}).get('thread',{}).get('status',{}).get('type')!='notLoaded':
    raise RuntimeError('saved thread was not cold after owner restart')
   recovered=await rpc(ws,62,'thread/resume',{'threadId':tid,'excludeTurns':True})
   if recovered.get('error'):raise RuntimeError('owner cold activation failed: '+json.dumps(recovered['error']))
   resumed_settings={key:recovered.get('result',{}).get(key) for key in saved_settings}
   if resumed_settings!=saved_settings:raise RuntimeError('owner settings changed during cold activation')
  print(json.dumps({'coldOwnerActivation':True,'ownerPidChanged':True,
   'ownerSettingsPreserved':True,'ownerSocketsChanged':True}),flush=True)
  page_fixture=ROOT/f'page-fixture-{TAG}'
  page_fixture.mkdir(mode=0o700)
  shutil.copytree(OWNER/'sessions',page_fixture/'sessions')
  for db_name in ('state_5.sqlite','thread_history_1.sqlite'):
   source=sqlite3.connect(f'file:{OWNER/db_name}?mode=ro',uri=True)
   target=sqlite3.connect(page_fixture/db_name)
   source.backup(target)
   source.close()
   if db_name=='state_5.sqlite':
    old=target.execute('SELECT rollout_path FROM threads WHERE id=?',(tid,)).fetchone()[0]
    selected=Path(old).relative_to(OWNER/'sessions')
    target.execute('UPDATE threads SET rollout_path=? WHERE id=?',(str(Path('/fixture/sessions')/selected),tid))
    target.commit()
   target.execute('PRAGMA journal_mode=DELETE')
   target.close()
  for run_label in ['first']:
   if run_label=='reopened' and RESTART_OWNER:
    old_owner_pid=first.pid;old_socket=owner_socket;old_state=owner_state
    private_owner_quit(first.pid)
    try:first.wait(timeout=15)
    except subprocess.TimeoutExpired:raise RuntimeError('owner did not quit from its private window')
    first=launch(1,displays[0])
    for _ in range(250):
     if first.poll() is not None:raise RuntimeError('restarted owner exited')
     if APP_SOCKET.is_socket() and STATE_SOCKET.is_socket():
      current_socket=APP_SOCKET.stat();current_state=STATE_SOCKET.stat()
      if ((current_socket.st_dev,current_socket.st_ino)!=(old_socket.st_dev,old_socket.st_ino)
       and (current_state.st_dev,current_state.st_ino)!=(old_state.st_dev,old_state.st_ino)):
       try:
        hello=state_req('hello')
        if hello.get('result',{}).get('ownerCodexHome')==str(OWNER):break
       except (OSError,ValueError):pass
     await asyncio.sleep(.05)
    else:raise RuntimeError('owner authority did not restart with new sockets')
    owner_socket=APP_SOCKET.stat();owner_state=STATE_SOCKET.stat()
    if first.pid==old_owner_pid:raise RuntimeError('owner process identity did not change')
    async with websockets.unix_connect(str(APP_SOCKET),uri='ws://localhost/rpc',compression=None) as ws:
     await rpc(ws,20,'initialize',{'clientInfo':{'name':'restart_smoke','title':'Restart smoke','version':'1'},'capabilities':{'experimentalApi':True}})
     await ws.send(json.dumps({'method':'initialized'}))
     recovered=await rpc(ws,21,'thread/resume',{'threadId':tid})
     if recovered.get('error'):raise RuntimeError('persisted thread did not resume: '+json.dumps(recovered['error']))
     read=await rpc(ws,22,'thread/read',{'threadId':tid,'includeTurns':True})
     if 'Orbit completed fixture answer' not in json.dumps(read):raise RuntimeError('completed answer missing after owner restart')
    projects=state_req('read',{'key':'local-projects'})
    if PROJECT_ID not in projects.get('result',{}):raise RuntimeError('fixture project missing after owner restart')
    print(json.dumps({'ownerRestarted':True,'ownerPidChanged':True,'socketInodesChanged':True,
     'projectRecovered':True,'threadAnswerRecovered':True}),flush=True)
   args=['bun',str(Path(__file__).with_name('orbit-attached-codex-switch.ts')),str(ROOT),str(APP_SOCKET),str(dirs(2,'config')/'dconf/user'),str(ORBIT_REPO),run_label,str(page_fixture),'/var/tmp/orbit-codex-source-tag/codex-rs/target/debug/deps/codex_thread_store-db4c58d0ebdf7cab',tid]
   if PUBLIC_ATTACH:
    manifest=ROOT/'candidate-manifest.json'
    if not manifest.is_file():raise RuntimeError('public attach needs the pinned candidate manifest')
    args.extend(['public',__import__('hashlib').sha256(manifest.read_bytes()).hexdigest()])
   if FOOTER_ONLY:args.append('footer-only')
   combined=subprocess.run(args,cwd=str(ORBIT_REPO),capture_output=True,text=True,timeout=90)
   print(combined.stdout,flush=True)
   if combined.returncode:raise RuntimeError('Orbit client failed: '+combined.stderr[-3000:])
   result=json.loads(combined.stdout.strip().splitlines()[-1])
   if not result['desktopAlive'] or result['privateAuthFile'] or result['privateProjectCount']!=1:raise RuntimeError('attached Desktop state mismatch')
   opened=Path(result['openedImagePath'])
   if opened.parent!=ROOT or not opened.is_file():raise RuntimeError('private screenshot missing')
   image_text=subprocess.run(['tesseract',str(opened),'stdout'],capture_output=True,text=True,check=True).stdout
   if FOOTER_ONLY:
    if 'orbit-owner' not in image_text.lower():raise RuntimeError('fake ChatGPT owner email missing from private footer screenshot')
   elif 'Orbit completed fixture answer' not in image_text or 'Private fixture conversation' not in image_text:raise RuntimeError('completed turn missing from private Desktop screenshot')
   audit_path=ROOT/'gate-audit-first.jsonl'
   audit=[json.loads(line) for line in audit_path.read_text().splitlines() if line]
   allowed_turns=sum(entry.get('method')=='turn/start' and entry.get('outcome')=='allow' for entry in audit)
   resume_requests=sum(entry.get('method')=='thread/resume' for entry in audit)
   model_requests=json.loads((ROOT/f'model-tools-{TAG}.json').read_text()).get('requests',[])
   tool_counts=[request.get('toolCount') for request in model_requests]
   rollouts=list((OWNER/'sessions').rglob(f'*{tid}.jsonl'))
   saved_private_turn=len(rollouts)==1 and b'Orbit private saved-thread follow-up' in rollouts[0].read_bytes()
   print(json.dumps({'uiAllowedTurns':allowed_turns,'uiResumeRequests':resume_requests,
    'modelToolCounts':tool_counts,'savedPrivateTurn':saved_private_turn}),flush=True)
   if allowed_turns!=1 or resume_requests!=0 or len(tool_counts)!=2 or tool_counts[0]<1 or tool_counts[1]!=0 or not saved_private_turn:
    raise RuntimeError('cold owner activation did not admit exactly one safe private UI turn')
   for path,original in [(APP_SOCKET,owner_socket),(STATE_SOCKET,owner_state)]:
    current=path.stat()
    if (current.st_dev,current.st_ino)!=(original.st_dev,original.st_ino):raise RuntimeError('owner socket changed')
   print(json.dumps({'run':run_label,'footerEmailVisible':FOOTER_ONLY,'privateAuthFile':False,'ownerSocketsUnchanged':True,'screenshot':str(opened)}),flush=True)

 finally:
  for p in reversed(desktops):stop(p)
  for p in reversed(xservers):stop(p)
  if real_session:
   try:broker_call(broker_socket,'session.stop',{'sessionId':real_session})
   except Exception:pass
  if broker:
   if broker.stdin:
    try:broker.stdin.close()
    except OSError:pass
   try:broker.wait(timeout=8)
   except subprocess.TimeoutExpired:stop(broker)
  for f in logs:f.close()
  shutil.rmtree(AUTH_DIR)
  print('private processes stopped')
asyncio.run(main())
