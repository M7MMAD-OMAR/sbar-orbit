'use strict';
(() => {
  const allowed = new Set(['version','status','doctor','update-status','update-check','updates-on','updates-off','connector-config']);
  const result = document.getElementById('result');
  const status = document.getElementById('busy');
  let sequence = 0, pending = null;
  function invoke(command) {
    if (!allowed.has(command) || pending !== null) return;
    pending = String(++sequence);
    status.textContent = 'Working';
    document.querySelectorAll('button').forEach(button => { button.disabled = true; });
    window.chrome.webview.postMessage({id:pending,command});
  }
  document.querySelectorAll('[data-command]').forEach(button => button.addEventListener('click', () => invoke(button.dataset.command)));
  window.chrome.webview.addEventListener('message', event => {
    const value = event.data;
    if (!value || typeof value !== 'object' || value.id !== pending) return;
    status.textContent = value.ok ? 'Complete' : 'Action unavailable';
    result.textContent = JSON.stringify(value.result ?? {error:value.error ?? 'Action failed'},null,2);
    if (value.command === 'version' && value.ok) {
      document.getElementById('version').textContent = 'Version ' + String(value.result.version ?? 'unknown');
    }
    pending = null;
    document.querySelectorAll('button').forEach(button => { button.disabled = false; });
  });
  invoke('version');
})();
