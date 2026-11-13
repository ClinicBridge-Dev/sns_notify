// Forwards inbox snapshots to the local collector. Settings live in chrome.storage.local.
const DEFAULTS = { serverUrl: 'http://localhost:8787', token: '' };

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(['serverUrl', 'token'])) };
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'ig_snapshot') {
    forward(msg.data, sender.tab && sender.tab.id).catch(() => {});
  }
});

async function forward(data, tabId) {
  const { serverUrl, token } = await settings();
  const at = new Date().toISOString();
  let result;
  if (!token) {
    result = { ok: false, error: '토큰이 설정되지 않음 (확장 프로그램 옵션)' };
  } else {
    try {
      const r = await fetch(`${serverUrl.replace(/\/$/, '')}/api/ingest/instagram`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-LW-Ingest-Token': token },
        body: JSON.stringify(data),
      });
      const body = await r.json().catch(() => ({}));
      result = r.ok ? { ok: true, new: body.new || 0, warning: body.warning } : { ok: false, error: `HTTP ${r.status} ${body.error || ''}` };
    } catch (e) {
      result = { ok: false, error: `수집기에 연결할 수 없음 (${serverUrl})` };
    }
  }
  const key = `last:${data.account}:${data.folder}`;
  await chrome.storage.local.set({ [key]: { at, tabId, data, result } });
}
