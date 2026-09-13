const element = id => document.getElementById(id);
const token = location.hash.slice(1);
const pointer = element('agent-pointer');
let agentName = 'SbarOrbit', actor = 'agent';
let previewMode = 'balanced', captureQueued = false, pollFailures = 0;
let lastCost = 0, lastGap = 0, lastRpc = 0, lastDecode = 0, lastDraw = 0;
element('preview-mode').addEventListener('change', () => { previewMode = element('preview-mode').value; captureQueued = false; });
element('refresh-frame').onclick = () => { captureQueued = true; };
const frame = element('frame'), sessions = element('sessions'), tabStrip = element('tabs'), shell = element('shell');
/*
 * Orbit's own palette is what the stylesheet falls back to, and the desktop's generated one is applied
 * only under this attribute, so following the desktop is a switch rather than the default. The choice is
 * remembered per browser; storage that is unavailable or blocked leaves Orbit's palette in place.
 */
const paletteButton = element('palette');
let desktopPalette = false;
try { desktopPalette = localStorage.getItem('orbit-palette') === 'desktop'; } catch { desktopPalette = false; }
function applyPalette() {
  document.documentElement?.setAttribute?.('data-palette', desktopPalette ? 'desktop' : 'orbit');
  paletteButton.setAttribute('aria-pressed', String(desktopPalette));
  paletteButton.textContent = desktopPalette ? 'Using my desktop colours' : 'Match my desktop colours';
}
/*
 * Bigger: the rail, the panels and the heading go away and the picture takes the
 * window. It changes nothing about the session, so unlike the screen size below
 * it needs no pause; it is the answer to "let me see it properly" that does not
 * move a single coordinate out from under the assistant.
 */
const biggerButton = element('expand');
let bigger = false;
biggerButton.onclick = () => {
  bigger = !bigger;
  shell.classList.toggle('bigger', bigger);
  biggerButton.setAttribute('aria-pressed', String(bigger));
  biggerButton.textContent = bigger ? 'Back to normal size' : 'Make it bigger';
};
paletteButton.onclick = () => {
  desktopPalette = !desktopPalette;
  try { localStorage.setItem('orbit-palette', desktopPalette ? 'desktop' : 'orbit'); } catch { /* not remembered */ }
  applyPalette();
};
applyPalette();
// Sizes an agent or a person can pick. The broker caps the total pixel count, because every frame
// at the chosen size is captured, encoded and decoded again on each poll.
const surfaces = [[1280, 800], [1440, 900], [1600, 1000], [1920, 1080], [1920, 1200]];
let tabs = [], surfaceValue = '1280x800', listed = [], railSignature = '';
let selected = '', state = '', backend = '', accountName = '', capturedAt = 0, imageWidth = 1280, imageHeight = 800, busy = false;
function error(message) { element('error').textContent = message; element('error').hidden = !message; }
async function rpc(method, params = {}) {
  const response = await fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(response.status === 403 ? 'Open the complete preview link printed by Orbit, including its access token.' : 'Viewer connection failed.');
  const result = await response.json();
  if (!result.ok) throw new Error(result.error.message);
  return result.result;
}
/*
 * What each state is called on screen. The state itself stays on `data-state`,
 * which is what anything reading the page for the state should use: the words
 * here are for a person, and a person should not have to learn that an assistant
 * is "running" or that they themselves are a "pause".
 */
const WORDS = { running: 'Open', paused: 'You are in control', closing: 'Finishing', closed: 'Finished' };
/* A session with nothing in flight is open, not working, and saying "Working" over an assistant that is
   sitting still is the kind of small lie that teaches a person to stop believing the screen. */
const words = (state, working) => working ? 'Working' : WORDS[state] || state || 'Unknown';
function controls() {
  element('state').textContent = state ? words(state, element('state').dataset.working === 'true') : 'Nothing selected yet';
  element('state').dataset.state = state;
  shell.dataset.state = state;
  const live = !!selected && !['closed', 'closing'].includes(state);
  element('pause').disabled = !live || busy || state !== 'running';
  element('resume').disabled = !live || busy || state !== 'paused';
  element('stop').disabled = !live || busy;
  for (const id of ['text', 'send', 'key', 'press']) element(id).disabled = !live || busy || state !== 'paused';
  if (backend === 'fedora') { element('key').disabled = true; element('press').disabled = true; }
  element('send').textContent = backend === 'fedora' ? 'Paste text' : 'Send text';
  element('text').maxLength = backend === 'fedora' ? 2048 : 16384;
  element('input-hint').textContent = backend === 'fedora'
    ? 'Choose Take over first. Then click or scroll on the picture above, and type here. Wait for each step to finish before the next one.'
    : 'Choose Take over first. Then click the picture above to pick a box, and type here.';
  element('account-controls').hidden = !accountName;
  element('account-label').textContent = accountName ? `This session signs in as ${accountName}. Take over, then save it so the next session starts already signed in.` : '';
  element('save-account').disabled = !accountName || !live || busy || state !== 'paused';
  const adjustable = live && !busy && state === 'paused';
  element('surface').disabled = !adjustable;
  // A greyed control with no reason beside it teaches nobody anything. Changing the screen size moves
  // every coordinate the assistant just read, which is why it waits for you to take over first.
  element('size-note').textContent = !live ? '' : adjustable ? '' : 'Take over first to change this';
  for (const id of ['fullscreen', 'restore']) { element(id).hidden = backend !== 'fedora'; element(id).disabled = !adjustable; }
  for (const button of tabStrip.children || []) button.disabled = !adjustable;
  frame.classList.toggle('controllable', adjustable);
}
/**
 * The rail: one card per session, which is the whole of navigation here. A drop-down showed one session
 * at a time and said nothing about the rest, so a person running several agents could not see which one
 * had stopped or which one was working without opening it.
 *
 * Rebuilt only when a card's own text changes, for the same reason the tab strip is: this runs inside the
 * poll, and the viewer's cost is the thing it is measured on.
 */
function renderSessions(list) {
  listed = list;
  const line = entry => `${entry.sessionId}/${entry.state}/${entry.agentName || ''}/${entry.taskName || ''}/${entry.activity?.state || ''}/${entry.sessionId === selected}`;
  const signature = list.map(line).join('|');
  element('session-count').textContent = list.length ? `Assistants · ${list.length}` : 'Assistants';
  if (signature === railSignature) return;
  railSignature = signature;
  if (!list.length) {
    const note = document.createElement('p');
    note.className = 'rail-note'; note.textContent = 'No sessions yet. Create one from your agent or the CLI.';
    sessions.replaceChildren(note);
    return;
  }
  sessions.replaceChildren(...list.map(entry => {
    const card = document.createElement('button');
    card.type = 'button'; card.className = 'session';
    // A plain button, announced as a button. `aria-current` says which session is on the stage without
    // promising the arrow key navigation a listbox role would, which the select this replaced gave for
    // free and this does not.
    if (entry.sessionId === selected) card.setAttribute('aria-current', 'true');
    card.dataset.state = entry.state || '';
    card.dataset.working = String(entry.activity?.state === 'working' && entry.state === 'running');
    const top = document.createElement('div'); top.className = 'session-top';
    const light = document.createElement('span'); light.className = 'dot';
    const who = document.createElement('span'); who.className = 'session-agent';
    who.textContent = entry.agentName || 'SbarOrbit';
    top.append(light, who);
    const task = document.createElement('div'); task.className = 'session-task';
    task.textContent = entry.taskName || entry.backend || 'Agent workspace';
    const meta = document.createElement('div'); meta.className = 'session-meta';
    // The short identifier earns its place only when two cards would otherwise read the same. It was
    // there to tell duplicates apart, and on every other card it is four characters of noise.
    const twin = list.filter(other => (other.agentName || '') === (entry.agentName || '')
      && (other.taskName || '') === (entry.taskName || '')).length > 1;
    const busyHere = entry.activity?.state === 'working' && entry.state === 'running';
    meta.textContent = `${entry.backend === 'fedora' ? 'App window' : 'Web page'} · ${words(entry.state, busyHere)}`
      + (twin ? ` · ${String(entry.sessionId).slice(0, 4)}` : '');
    card.append(top, task, meta);
    card.onclick = () => selectSession(entry.sessionId);
    return card;
  }));
}
/** One entry per browser tab or per window of the private display, numbered the way observe reports them. */
function renderTabs(list) {
  const same = list.length === tabs.length && list.every((entry, index) => entry.label === tabs[index].label && entry.active === tabs[index].active);
  tabs = list;
  tabStrip.hidden = list.length < 2;
  if (same) return;
  tabStrip.replaceChildren(...list.map(entry => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'tab'; button.textContent = entry.label || `Tab ${entry.tab}`;
    button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(!!entry.active));
    button.onclick = () => command('session.control', { input: backend === 'fedora'
      ? { type: 'window', command: 'focus', tab: entry.tab } : { type: 'select-tab', tab: entry.tab } });
    return button;
  }));
  controls();
}
async function refreshSessions() {
  const list = await rpc('session.list');
  const previous = selected;
  if (!list.some(s => s.sessionId === selected)) selected = list.find(s => s.state !== 'closed')?.sessionId || list[0]?.sessionId || '';
  renderSessions(list);
  if (previous !== selected) { element('account-result').textContent = ''; capturedAt = 0; frame.hidden = true; pointer.hidden = true; element('page-title').textContent = 'Waiting to see what it is looking at'; element('page-location').textContent = '';  }
  const current = list.find(s => s.sessionId === selected);
  agentName = current?.agentName || 'SbarOrbit';
  actor = current?.activity?.actor || 'agent';
  element('agent-name').textContent = agentName;
  element('task-name').textContent = current?.taskName || 'Agent workspace';
  const activity = current?.activity;
  const verbs = { navigate: 'opening a page', fill: 'filling in a box', click: 'clicking', read: 'reading the page', scroll: 'scrolling', pointer: 'clicking', text: 'typing', paste: 'pasting', key: 'pressing a key', launch: 'opening an application' };
  const outcome = { working: 'right now', done: 'just now', failed: 'and it did not work' };
  element('activity').textContent = activity
    ? `${activity.actor === 'human' ? 'You' : agentName} ${activity.actor === 'human' ? 'were' : 'is'} ${verbs[activity.type] || 'doing something'} ${outcome[activity.state] || activity.state} · step ${activity.sequence}`
    : 'Nothing has happened yet';
  // What makes the stage glow. An action in flight is the only honest signal the viewer has for "the
  // agent is doing something right now"; a running session with nothing in flight is merely open.
  const working = String(activity?.state === 'working' && current?.state === 'running');
  shell.dataset.working = working;
  element('state').dataset.working = working;
  element('agent-badge').dataset.working = working;
  // controls() reads this back for the chip's word, so it is set before that call, not after.
  state = current?.state || '';
  backend = list.find(s => s.sessionId === selected)?.backend || '';
  const size = current?.surface;
  if (size) {
    const value = `${size.width}x${size.height}`;
    if (value !== surfaceValue || !(element('surface').options || []).length) {
      surfaceValue = value;
      const choices = surfaces.some(([w, h]) => `${w}x${h}` === value) ? surfaces : [...surfaces, [size.width, size.height]];
      element('surface').replaceChildren(...choices.map(([w, h]) => {
        const option = document.createElement('option');
        option.value = `${w}x${h}`; option.textContent = `${w} × ${h}`; return option;
      }));
      element('surface').value = value;
    }
  }
  accountName = list.find(s => s.sessionId === selected)?.accountName || '';
  element('empty').hidden = !!selected && !frame.hidden;
  if (state === 'closed') { capturedAt = 0; frame.hidden = true; pointer.hidden = true; element('page-title').textContent = 'Waiting to see what it is looking at'; element('page-location').textContent = '';  element('empty').hidden = false; element('empty').textContent = 'This session has finished.'; }
  controls();
}
function selectSession(id) {
  if (id === selected) return;
  selected = id; state = ''; capturedAt = 0; frame.hidden = true; pointer.hidden = true;
  element('page-title').textContent = 'Waiting to see what it is looking at';
  element('page-location').textContent = '';
  controls(); renderSessions(listed);
}
async function command(method, params = {}) {
  if (busy || !selected) return;
  busy = true; controls(); error('');
  try { await rpc(method, { sessionId: selected, ...params }); if (method === 'session.account.save') element('account-result').textContent = ' Account state saved.'; await refreshSessions(); }
  catch (e) { error(e.message); }
  finally { busy = false; controls(); }
}
element('surface').addEventListener('change', () => {
  const [width, height] = element('surface').value.split('x').map(Number);
  if (width && height) command('session.control', { input: { type: 'resize', width, height } });
});
element('fullscreen').onclick = () => command('session.control', { input: { type: 'window', command: 'fullscreen' } });
element('restore').onclick = () => command('session.control', { input: { type: 'window', command: 'restore' } });
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
    if (document.hidden) { setTimeout(poll, 1000); return; }
    await refreshSessions();
    element('connection').textContent = 'Connected';
    element('connection').dataset.connected = 'true';
    const id = selected;
    if (!document.hidden && id && !['closed', 'closing'].includes(state) && (previewMode !== 'manual' || captureQueued)) {
      captureQueued = false;
      const requested = performance.now();
      const image = await rpc('session.observe', { sessionId: id });
      lastRpc = performance.now() - requested;
      if (!document.hidden && selected === id && !['closed', 'closing'].includes(state)) {
        const decodeStarted = performance.now();
        // The engine's own base64 decoder where it exists, rather than a JavaScript callback per byte of
        // every frame. A data URL through fetch would do the same, and the page's connect-src forbids it.
        const bytes = typeof Uint8Array.fromBase64 === 'function' ? Uint8Array.fromBase64(image.image) : Uint8Array.from(atob(image.image), character => character.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: image.mimeType }));
        lastDecode = performance.now() - decodeStarted;
        try {
          if (!document.hidden && selected === id && !['closed', 'closing'].includes(state)) {
            if (frame.width !== image.width || frame.height !== image.height) {
              frame.width = image.width; frame.height = image.height;
            }
            const drawStarted = performance.now();
            frame.getContext('2d').drawImage(bitmap, 0, 0);
            lastDraw = performance.now() - drawStarted;
            capturedAt = image.capturedAt; imageWidth = image.width; imageHeight = image.height;
            // Read by the bigger view, which sizes the picture from the height of the window. It is set
            // as a width so the canvas and the box the pointer is placed in stay the same rectangle.
            element('stage').style.setProperty?.('--shot-width', String(image.width));
            element('stage').style.setProperty?.('--shot-height', String(image.height));
            frame.dataset.capturedAt = String(capturedAt);
            frame.hidden = false; element('empty').hidden = true;
            const presence = image.presence;
            element('page-title').textContent = presence?.title || 'Untitled page or application';
            // The size used to be repeated here; it is on the Screen size control, which is also where a
            // person can do something about it.
            element('page-location').textContent = `${presence?.location || ''}${presence?.pageCount > 1 ? ` · tab ${presence.pageIndex || 1} of ${presence.pageCount}` : ''}`;
            renderTabs(Array.isArray(presence?.tabs) ? presence.tabs : []);
            const position = presence?.pointer;
            pointer.hidden = !position;
            if (position) {
              pointer.classList.toggle('stale', false);
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
  pollFailures = 0;
  } catch (e) { pollFailures++; element('connection').textContent = 'Lost the connection, trying again'; element('connection').dataset.connected = 'false'; error(e.message); }
  const cadence = pollFailures ? Math.min(10000, 1000 * 2 ** Math.min(pollFailures - 1, 4)) : previewMode === 'smooth' ? 200 : 1000;
  // Idle at least as long as the iteration cost, so a viewer that cannot keep up
  // drops its frame rate instead of polling back to back and taking a whole core.
  lastCost = Math.max(0, performance.now() - started);
  lastGap = Math.max(cadence - lastCost, lastCost, 50);
  setTimeout(poll, lastGap);
}
// Text is assigned only when it changes: at four ticks a second, rewriting an unchanged node still
// invalidates it, and the readout is looked at far less often than it is ticked.
const setText = (id, text) => { const node = element(id); if (node.textContent !== text) node.textContent = text; };
setInterval(() => {
  if (document.hidden) return;
  const age = capturedAt ? Date.now() - capturedAt : Infinity;
  const share = lastCost + lastGap > 0 ? Math.round(lastCost / (lastCost + lastGap) * 100) : 0;
  setText('freshness', capturedAt
    ? age < 1500 ? 'Picture is up to date' : `Picture is ${Math.round(age / 1000)} seconds old`
    : 'Waiting for the first picture');
  setText('cost', lastCost
    ? `Viewer cycle: ${Math.round(lastCost)} ms of every ${Math.round(lastCost + lastGap)} ms (${share}%) · request ${Math.round(lastRpc)} ms · decode ${Math.round(lastDecode)} ms · draw ${Math.round(lastDraw)} ms`
    : '');
  const staleAfter = previewMode === 'smooth' ? 1000 : 2000;
  element('freshness').classList.toggle('stale', age > staleAfter);
  // A pointer over a stale frame is dimmed rather than removed. Hiding it meant that at the default one
  // frame a second it spent most of its life invisible, so the marker that says where the agent is
  // working was the one thing on the page you could not rely on seeing.
  pointer.classList.toggle('stale', age > staleAfter);
}, 250);
if (!token) { element('connection').textContent = 'This link is incomplete'; element('connection').dataset.connected = 'false'; error('Open the complete preview link printed by Orbit.'); }
else poll();
