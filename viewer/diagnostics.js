(() => {
  const prepare = document.getElementById('prepare-report');
  const status = document.getElementById('report-status');
  const actions = document.getElementById('report-actions');
  let prepared;
  let lastPrepared = 0, latestErrorId;
  prepare.onclick = async () => {
    lastPrepared = Date.now();
    prepare.disabled = true;
    status.textContent = 'Preparing your report...';
    actions.hidden = true;
    try {
      prepared = await rpc('diagnostics.report');
      document.getElementById('report-github').href = prepared.issueUrl;
      const errors = prepared.events.filter(event => event.outcome === 'error').length;
      const incomplete = prepared.collection.failedWrites || prepared.collection.failedReads;
      status.textContent = `Report ready: ${errors} recorded errors. ${incomplete ? 'Some diagnostic records could not be saved or read.' : 'Recent tool history is included.'}`;
      actions.hidden = false;
      const panel = document.getElementById('report-panel');
      if (panel) panel.open = true;
    } catch {
      prepared = undefined;
      status.textContent = 'Orbit is unavailable. Run sbar-orbit diagnostics to recover the saved report without the service.';
    } finally { prepare.disabled = false; }
  };
  document.getElementById('download-report').onclick = () => {
    if (!prepared) return;
    const { issueUrl, ...report } = prepared;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `orbit-report-${report.reportId}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  // Prepare after an error without opening a page or transmitting anything.
  const errors = document.getElementById('error');
  new MutationObserver(() => {
    if (errors.textContent && !prepare.disabled && Date.now() - lastPrepared > 30000) prepare.click();
  }).observe(errors, { childList: true, characterData: true, subtree: true });
  // Agent tool failures happen outside this page. Poll only their small status marker.
  async function checkFailures() {
    try {
      const state = await rpc('diagnostics.status');
      if (state.latestErrorId && state.latestErrorId !== latestErrorId && !prepare.disabled && Date.now() - lastPrepared > 30000) {
        latestErrorId = state.latestErrorId;
        prepare.click();
      }
    } catch { /* The connection indicator owns transport failures. */ }
    setTimeout(checkFailures, 15000);
  }
  checkFailures();
})();
