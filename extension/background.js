importScripts('lib/constants.js', 'lib/settings.js', 'lib/serial.js', 'lib/deepl.js');

const MBX = self.MBX;
const runSerial = MBX.createSerialQueue();

// 직렬 큐를 거치지 않는 핸들러. 저장소를 읽고 쓰지 않고 오래 걸리는 외부 호출만 하는 것에 한해 쓴다.
// sender 검사와 isAllowed 검사는 큐를 쓰는 핸들러와 똑같이 거친다.
const UNQUEUED_TYPES = ['TRANSLATE', 'CHECK_DEEPL_KEY'];

// handlers[type] = async (msg, sender) => response. 이후 Task는 여기에 핸들러만 추가한다.
const handlers = {};

function defaultState() {
  return {
    settings: Object.assign({}, MBX.DEFAULT_SETTINGS),
    quickReplies: { version: 1, items: [] },
    watcherState: {
      channels: {
        instagram_direct: { base: 0, known: false, pending: null },
        wec: { base: 0, known: false, pending: null }
      },
      ownerTabId: null, lastHeartbeat: 0, everSeen: false,
      stoppedAlertSent: false, lastAlarmAt: 0
    },
    threadLangs: {},
    slackQueue: [],
    sentKeys: [],
    recentCountAlerts: [],
    lastError: null
  };
}

// 저장소 접근은 이 두 함수로만 한다.
async function loadState(keys) {
  return chrome.storage.local.get(keys);
}
async function saveState(patch) {
  return chrome.storage.local.set(patch);
}

async function ensureDefaults() {
  const defaults = defaultState();
  const existing = await loadState(Object.keys(defaults));
  const missing = {};
  Object.keys(defaults).forEach(function (k) {
    if (!(k in existing)) missing[k] = defaults[k];
  });
  if (Object.keys(missing).length) await saveState(missing);
}

try {
  // content script가 저장소를 읽지 못하게 한다(비밀값 보호).
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
    .catch(function () { console.debug('setAccessLevel rejected'); });
} catch (e) {
  console.debug('setAccessLevel failed');
}
runSerial(ensureDefaults).catch(function () { console.debug('ensureDefaults failed'); });

handlers.GET_PUBLIC_SETTINGS = async function () {
  const { settings } = await loadState(['settings']);
  return MBX.publicSettings(Object.assign({}, MBX.DEFAULT_SETTINGS, settings));
};

handlers.GET_QUICK_REPLIES = async function () {
  const { quickReplies } = await loadState(['quickReplies']);
  const qr = quickReplies || {};
  return { version: 1, items: Array.isArray(qr.items) ? qr.items : [] };
};

handlers.OPEN_OPTIONS = async function () {
  chrome.runtime.openOptionsPage();
};

// DeepL 호출. 키는 service worker 안에서만 쓰고 응답에 넣지 않는다. 본문과 키는 로그에 남기지 않는다.
async function deeplFetch(req) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, MBX.DEEPL_TIMEOUT_MS);
  try {
    const res = await fetch(req.url, Object.assign({}, req.init, { signal: ctrl.signal }));
    if (!res.ok) { console.debug('deepl http', res.status); return { ok: false, error: MBX.mapDeeplError(res.status) }; }
    return { ok: true, json: await res.json() };
  } catch (e) {
    console.debug('deepl network/timeout');
    return { ok: false, error: MBX.mapDeeplError(0) };
  } finally {
    clearTimeout(timer);
  }
}

async function getDeeplKey() {
  const { settings } = await loadState(['settings']);
  return (settings && typeof settings.deeplApiKey === 'string') ? settings.deeplApiKey.trim() : '';
}

function fail(e) { return { ok: false, code: e.code, message: e.message }; }

handlers.TRANSLATE = async function (msg) {
  const text = msg.text;
  if (typeof text !== 'string' || typeof msg.targetLang !== 'string' || (msg.purpose !== 'bubble' && msg.purpose !== 'send')) {
    return { ok: false, code: 'REJECTED' };
  }
  if (text.length > MBX.TRANSLATE_MAX_CHARS) return fail(MBX.TOO_LONG);
  const key = await getDeeplKey();
  if (!key) return fail(MBX.NO_KEY);
  const r = await deeplFetch(MBX.buildTranslateRequest({ text: text, targetLang: msg.targetLang, purpose: msg.purpose }, key));
  if (!r.ok) return fail(r.error);
  const t = r.json && r.json.translations && r.json.translations[0];
  if (!t || typeof t.text !== 'string') return fail(MBX.mapDeeplError(0));
  return { ok: true, text: t.text, detectedLang: t.detected_source_language };
};

handlers.CHECK_DEEPL_KEY = async function () {
  const key = await getDeeplKey();
  if (!key) return fail(MBX.NO_KEY);
  const r = await deeplFetch(MBX.buildUsageRequest(key));
  if (!r.ok) return fail(r.error);
  return { ok: true, used: r.json.character_count, limit: r.json.character_limit };
};

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  const kind = MBX.classifySender(sender, chrome.runtime.id);
  const type = msg && msg.type;
  if (kind === 'reject' || typeof type !== 'string' || !MBX.isAllowed(type, kind) ||
      !Object.prototype.hasOwnProperty.call(handlers, type)) {
    sendResponse({ ok: false, code: 'REJECTED' });
    return false;
  }
  const run = UNQUEUED_TYPES.indexOf(type) >= 0 ? function (f) { return Promise.resolve().then(f); } : runSerial;
  run(function () { return handlers[type](msg, sender); })
    .then(function (res) { sendResponse(res); })
    .catch(function () {
      console.debug('handler failed', type);
      sendResponse({ ok: false, code: 'INTERNAL' });
    });
  return true;
});

// ---- content script 연결(port) ----
// 연결된 port 목록은 캐시일 뿐이다(service worker가 종료되면 사라진다). 영속 상태는 Task 12에서 저장소에 둔다.
const ports = new Set();

function portIsContent(port) {
  // classifySender 와 같은 기준: sender.id, sender.tab.url 이 business.facebook.com 인 content 만 받는다.
  return MBX.classifySender(port.sender, chrome.runtime.id) === 'content';
}

async function handleHello(port, msg) {
  if (!msg || msg.type !== 'HELLO' || !MBX.isAllowed('HELLO', 'content')) return;
  const assetId = typeof msg.asset_id === 'string' ? msg.asset_id : '';
  const { settings } = await loadState(['settings']);
  const full = Object.assign({}, MBX.DEFAULT_SETTINGS, settings);
  // 비밀값은 절대 넣지 않는다.
  port.postMessage({ type: 'HELLO_REPLY', settings: MBX.publicSettings(full), role: MBX.roleFor(full, assetId) });
}

chrome.runtime.onConnect.addListener(function (port) {
  if (!portIsContent(port)) { port.disconnect(); return; }
  ports.add(port);
  port.onDisconnect.addListener(function () { ports.delete(port); });
  port.onMessage.addListener(function (msg) {
    runSerial(function () { return handleHello(port, msg); })
      .catch(function () { console.debug('hello failed'); });
  });
});

// settings, quickReplies 가 바뀌면 연결된 탭에 알린다.
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local' || (!changes.settings && !changes.quickReplies)) return;
  runSerial(async function () {
    const { settings } = await loadState(['settings']);
    const pub = MBX.publicSettings(Object.assign({}, MBX.DEFAULT_SETTINGS, settings));
    const msg = { type: 'SETTINGS_CHANGED', settings: pub, quickRepliesChanged: !!changes.quickReplies };
    ports.forEach(function (p) {
      try { p.postMessage(msg); } catch (e) { ports.delete(p); }
    });
  }).catch(function () { console.debug('settings push failed'); });
});
