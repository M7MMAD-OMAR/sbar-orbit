const element = id => document.getElementById(id);
const token = location.hash.slice(1);
const pointer = element('agent-pointer');
let agentName = 'SbarOrbit', actor = 'agent';
const frame = element('frame'), sessions = element('sessions');
let selected = '', state = '', backend = '', accountName = '', capturedAt = 0, imageWidth = 1280, imageHeight = 800, busy = false;
function error(message) { element('error').textContent = message; element('error').hidden = !message; }
async function rpc(method, params = {}) {
  const response = await fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ method, params }) });
  if (!response.ok) throw new Error(response.status === 403 ? 'Open the complete preview link printed by Orbit, including its access token.' : 'Viewer connection failed.');
  const result = await response.json();
  if (!result.ok) throw new Error(result.error.message);
  return result.result;
}
function controls() {
  element('state').textContent = state || 'No session selected';
  const live = !!selected && !['closed', 'closing'].includes(state);
  element('pause').disabled = !live || busy || state !== 'running';
  element('resume').disabled = !live || busy || state !== 'paused';
  element('stop').disabled = !live || busy;
  for (const id of ['text', 'send', 'key', 'press']) element(id).disabled = !live || busy || state !== 'paused';
  if (backend === 'fedora') { element('key').disabled = true; element('press').disabled = true; }
  element('send').textContent = backend === 'fedora' ? 'Paste text' : 'Send text';
  element('text').maxLength = backend === 'fedora' ? 2048 : 16384;
  element('input-hint').textContent = backend === 'fedora'
    ? 'Pause to click or scroll over the image. Paste uses this workspace\'s private clipboard. Wait for each action to finish.'
    : 'Pause the agent, then click or scroll over its page above. Send text or a key below.';
  element('account-controls').hidden = !accountName;
  element('account-label').textContent = accountName ? `Account snapshot: ${accountName}. Pause, then save to reuse its login later.` : '';
  element('save-account').disabled = !accountName || !live || busy || state !== 'paused';
  frame.classList.toggle('controllable', live && !busy && state === 'paused');
}
async function refreshSessions() {
  const list = await rpc('session.list');
  const previous = selected;
  if (!list.some(s => s.sessionId === selected)) selected = list.find(s => s.state !== 'closed')?.sessionId || list[0]?.sessionId || '';
  sessions.replaceChildren(...list.map(s => {
    const option = document.createElement('option'); option.value = s.sessionId; option.textContent = `${s.agentName || "SbarOrbit"} · ${s.taskName || s.backend} · ${s.sessionId.slice(0, 4)} / ${s.state}`; return option;
  }));
  if (!list.length) { const option = document.createElement('option'); option.textContent = 'No sessions'; sessions.append(option); }
  sessions.value = selected;
  if (previous !== selected) { element('account-result').textContent = ''; capturedAt = 0; frame.hidden = true; pointer.hidden = true; element('page-title').textContent = 'Waiting for the current page or application'; element('page-location').textContent = '';  }
  const current = list.find(s => s.sessionId === selected);
  agentName = current?.agentName || 'SbarOrbit';
  actor = current?.activity?.actor || 'agent';
  element('agent-name').textContent = agentName;
  element('task-name').textContent = current?.taskName || 'Agent workspace';
  const activity = current?.activity;
  const verbs = { navigate: 'Open page', fill: 'Fill field', click: 'Click', read: 'Read page', scroll: 'Scroll', pointer: 'Click', text: 'Type', paste: 'Paste', key: 'Press key', launch: 'Open application' };
  element('activity').textContent = activity ? `${activity.actor === 'human' ? 'You' : agentName}: ${verbs[activity.type] || 'Input'} · ${activity.state} · Step ${activity.sequence}` : 'No actions yet';
  state = current?.state || '';
  backend = list.find(s => s.sessionId === selected)?.backend || '';
  accountName = list.find(s => s.sessionId === selected)?.accountName || '';
  element('empty').hidden = !!selected && !frame.hidden;
  if (state === 'closed') { capturedAt = 0; frame.hidden = true; pointer.hidden = true; element('page-title').textContent = 'Waiting for the current page or application'; element('page-location').textContent = '';  element('empty').hidden = false; element('empty').textContent = 'This session has stopped.'; }
  controls();
}
sessions.addEventListener('change', () => { selected = sessions.value; state = ''; capturedAt = 0; frame.hidden = true; pointer.hidden = true; element('page-title').textContent = 'Waiting for the current page or application'; element('page-location').textContent = '';  controls(); });
async function command(method, params = {}) {
  if (busy || !selected) return;
  busy = true; controls(); error('');
  try { await rpc(method, { sessionId: selected, ...params }); if (method === 'session.account.save') element('account-result').textContent = ' Account state saved.'; await refreshSessions(); }
  catch (e) { error(e.message); }
  finally { busy = false; controls(); }
}
element('save-account').onclick = () => command('session.account.save');
for (const name of ['pause', 'resume', 'stop']) element(name).onclick = () => command(`session.${name}`);
element('send').onclick = () => command('session.control', { input: { type: backend === 'fedora' ? 'paste' : 'text', text: element('text').value } });
element('press').onclick = () => command('session.control', { input: { type: 'key', key: element('key').value } });
frame.onclick = event => {
  if (state !== 'paused' || busy) return;
  const rect = frame.getBoundingClientRect();
  command('session.control', { input: { type: 'click', x: Math.min(imageWidth - 1, Math.max(0, (event.clientX - rect.left) / rect.width * imageWidth)), y: Math.min(imageHeight - 1, Math.max(0, (event.clientY - rect.top) / rect.height * imageHeight)) } });
};
frame.addEventListener('wheel', event => {
  if (!['fedora', 'browser'].includes(backend) || state !== 'paused' || frame.hidden || !capturedAt) return;
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
  event.preventDefault();
  // Keep manual input serial, without replaying queued gestures after resume.
  if (busy) return;
  const rect = frame.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 3 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 0.2 : 100;
  const steps = Math.sign(event.deltaY) * Math.min(20, Math.max(1, Math.round(Math.abs(event.deltaY) / unit)));
  command('session.control', { input: { type: 'scroll',
    x: Math.min(imageWidth - 1, Math.max(0, Math.round((event.clientX - rect.left) / rect.width * imageWidth))),
    y: Math.min(imageHeight - 1, Math.max(0, Math.round((event.clientY - rect.top) / rect.height * imageHeight))),
    deltaY: steps } });
}, { passive: false });
async function poll() {
  const started = performance.now();
  try {
    await refreshSessions();
    element('connection').textContent = 'Connected locally';
    const id = selected;
    if (id && !['closed', 'closing'].includes(state) && !document.hidden) {
      const image = await rpc('session.observe', { sessionId: id });
      if (selected === id && !['closed', 'closing'].includes(state)) {
        const bytes = Uint8Array.from(atob(image.image), character => character.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: image.mimeType }));
        try {
          if (selected === id && !['closed', 'closing'].includes(state)) {
            if (frame.width !== image.width || frame.height !== image.height) {
              frame.width = image.width; frame.height = image.height;
            }
            frame.getContext('2d').drawImage(bitmap, 0, 0);
            capturedAt = image.capturedAt; imageWidth = image.width; imageHeight = image.height;
            frame.dataset.capturedAt = String(capturedAt);
            frame.hidden = false; element('empty').hidden = true;
            const presence = image.presence;
            element('page-title').textContent = presence?.title || 'Untitled page or application';
            element('page-location').textContent = `${presence?.location || ''}${presence?.pageCount ? ` · Controlled tab ${presence.pageIndex || 1} of ${presence.pageCount}` : ''}`;
            const position = presence?.pointer;
            pointer.hidden = !position;
            if (position) {
              pointer.style.left = `${position.x / imageWidth * 100}%`;
              pointer.style.top = `${position.y / imageHeight * 100}%`;
              pointer.classList.toggle('human', actor === 'human');
              pointer.classList.toggle('near-right', position.x > imageWidth * 0.75);
              element('pointer-label').textContent = actor === 'human' ? 'You' : agentName;
            }
          }
        } finally { bitmap.close(); }
      }
    }
  } catch (e) { element('connection').textContent = 'Connection interrupted'; error(e.message); }
  setTimeout(poll, document.hidden ? 1000 : Math.max(0, 200 - (performance.now() - started)));
}
setInterval(() => {
  const age = capturedAt ? Date.now() - capturedAt : Infinity;
  element('freshness').textContent = capturedAt ? `Frame age: ${(age / 1000).toFixed(1)}s` : 'Waiting for a frame';
  element('freshness').classList.toggle('stale', age > 1000);
  if (age > 1000) pointer.hidden = true;
}, 100);
if (!token) { element('connection').textContent = 'Access link required'; error('Open the complete preview link printed by Orbit.'); }
else poll();
