importScripts('lib/constants.js', 'lib/settings.js', 'lib/serial.js', 'lib/deepl.js', 'lib/threadlang.js', 'lib/badge.js');

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

// 대화별 번역 언어. 직렬 큐 안에서 읽고 쓴다. 응답에 threadId를 함께 돌려준다(content가 현재 대화와 비교한다).
handlers.SET_THREAD_LANG = async function (msg) {
  if (typeof msg.threadId !== 'string' || !msg.threadId || !MBX.isValidThreadLang(msg.lang)) {
    return { ok: false, code: 'REJECTED' };
  }
  const { threadLangs } = await loadState(['threadLangs']);
  await saveState({ threadLangs: MBX.setThreadLang(threadLangs, msg.threadId, msg.lang, Date.now(), MBX.THREAD_LANG_CAP) });
  return { ok: true };
};

handlers.GET_THREAD_LANG = async function (msg) {
  if (typeof msg.threadId !== 'string' || !msg.threadId) return { ok: false, code: 'REJECTED' };
  const st = await loadState(['threadLangs', 'settings']);
  const full = Object.assign({}, MBX.DEFAULT_SETTINGS, st.settings);
  return { threadId: msg.threadId, lang: MBX.getThreadLang(st.threadLangs, msg.threadId, full.sendTargetLang) };
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
    .then(function (res) { sendResponse(res === undefined ? { ok: true } : res); })
    .catch(function () {
      console.debug('handler failed', type);
      sendResponse({ ok: false, code: 'INTERNAL' });
    });
  return true;
});

// ---- content script 연결(port) ----
// port별 정보는 캐시일 뿐이다(service worker가 종료되면 사라진다). 영속 상태는 Task 12에서 저장소에 둔다.
const ports = new Map(); // port -> { assetId, path, tabId, role }

function portIsContent(port) {
  // classifySender 와 같은 기준: sender.id, sender.tab.url 이 business.facebook.com 인 content 만 받는다.
  return MBX.classifySender(port.sender, chrome.runtime.id) === 'content';
}

// role 계산은 이 함수 한 곳에서만 한다. Task 12에서 감지 담당 선정으로 바뀐다.
function computeRole(fullSettings, info) {
  return MBX.roleFor(fullSettings, info.assetId);
}

async function readFullSettings() {
  const { settings } = await loadState(['settings']);
  return Object.assign({}, MBX.DEFAULT_SETTINGS, settings);
}

async function handleHello(port, msg) {
  if (!msg || msg.type !== 'HELLO' || !MBX.isAllowed('HELLO', 'content') || !ports.has(port)) return;
  const info = ports.get(port);
  info.assetId = typeof msg.asset_id === 'string' ? msg.asset_id : '';
  info.path = typeof msg.path === 'string' ? msg.path : '';
  const full = await readFullSettings();
  info.role = computeRole(full, info);
  // 비밀값은 절대 넣지 않는다.
  port.postMessage({ type: 'HELLO_REPLY', settings: MBX.publicSettings(full), role: info.role });
}

chrome.runtime.onConnect.addListener(function (port) {
  if (!portIsContent(port)) { port.disconnect(); return; }
  ports.set(port, { assetId: '', path: '', tabId: port.sender.tab ? port.sender.tab.id : null, role: null });
  port.onDisconnect.addListener(function () { ports.delete(port); });
  port.onMessage.addListener(function (msg) {
    runSerial(function () { return handleHello(port, msg); })
      .catch(function () { console.debug('hello failed'); });
  });
});

// settings, quickReplies 가 바뀌면 연결된 탭에 알리고, 바뀐 role 도 다시 알린다.
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local' || (!changes.settings && !changes.quickReplies)) return;
  runSerial(async function () {
    const full = await readFullSettings();
    const msg = { type: 'SETTINGS_CHANGED', settings: MBX.publicSettings(full), quickRepliesChanged: !!changes.quickReplies };
    ports.forEach(function (info, p) {
      try {
        p.postMessage(msg);
        if (info.role === null) return; // 아직 HELLO 전이면 HELLO 응답이 role 을 준다
        const role = computeRole(full, info);
        if (role !== info.role) { info.role = role; p.postMessage({ type: 'WATCHER_ROLE', role: role }); }
      } catch (e) { ports.delete(p); }
    });
  }).catch(function () { console.debug('settings push failed'); });
});

// ---- 배지 기준값 판단(기획서 6-1 신호 1) ----
// Task 11에서 결합 로직에 연결한다. 지금은 메시지 본문 없이 채널과 건수만 남긴다.
function onBadgeEvent(ev) {
  console.debug('badge event', ev.channel, ev.count, ev.kind);
}

// 직렬 큐 안에서 실행된다(onMessage 라우터). 담당 탭 검사는 Task 12에서 추가한다.
handlers.BADGE_STATE = async function (msg) {
  const st = await loadState(['watcherState', 'settings']);
  const full = Object.assign({}, MBX.DEFAULT_SETTINGS, st.settings);
  if (typeof msg.asset_id !== 'string' || msg.asset_id !== full.assetId) return { ok: false, code: 'REJECTED' };
  const r = MBX.handleBadgeState(st.watcherState || defaultState().watcherState, msg, Date.now());
  if (r.state === (st.watcherState)) return { ok: false, code: 'REJECTED' }; // 형식이 틀린 보고
  await saveState({ watcherState: r.state });
  r.events.forEach(onBadgeEvent);
  return { ok: true };
};
