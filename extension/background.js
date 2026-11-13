importScripts('lib/constants.js', 'lib/settings.js', 'lib/serial.js', 'lib/deepl.js', 'lib/threadlang.js', 'lib/badge.js', 'lib/listcand.js', 'lib/slack.js', 'lib/combine.js', 'lib/owner.js', 'lib/watchdog.js', 'lib/status.js');

const MBX = self.MBX;
const runSerial = MBX.createSerialQueue();

// 직렬 큐를 거치지 않는 핸들러. 저장소를 읽고 쓰지 않고 오래 걸리는 외부 호출만 하는 것에 한해 쓴다.
// sender 검사와 isAllowed 검사는 큐를 쓰는 핸들러와 똑같이 거친다.
const UNQUEUED_TYPES = ['TRANSLATE', 'CHECK_DEEPL_KEY', 'SEND_TEST_SLACK'];

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
      stoppedAlertSent: false, lastAlarmAt: 0, failAlerts: [],
      inboxTabIds: [] // 수신함 경로에서 소식을 보낸 탭(로그인 경고 허용 판단). port 끊김으로는 지우지 않는다
    },
    tabsSeen: [], // [{ tabId, assetId, path, lastSeen }] 수신함 탭(HELLO·HEARTBEAT로 갱신)
    lastSend: null, // { at, outcome, status } 마지막 Slack 전송 결과(주소·본문 없음)
    threadLangs: {},
    slackQueue: [],
    sentKeys: [],
    recentCountAlerts: [],
    lastError: null,
    statusInfo: defaultStatusInfo() // 설정 화면 상태 표시용(UI 수정 기획서 7-2). 본문, 키, Webhook 주소는 넣지 않는다
  };
}

function defaultDeeplStatus() { return { checkedAt: 0, ok: false, code: '', used: 0, limit: 0 }; }
function defaultStatusInfo() { return { deepl: defaultDeeplStatus(), slackTestOkAt: 0 }; }

// statusInfo 일부를 고친다. 직렬 큐 안에서 부른다.
async function patchStatusInfo(fn) {
  const { statusInfo } = await loadState(['statusInfo']);
  const cur = Object.assign(defaultStatusInfo(), statusInfo);
  cur.deepl = Object.assign(defaultDeeplStatus(), cur.deepl);
  await saveState({ statusInfo: fn(cur) || cur });
}

// 사이트 액세스 권한(UI 수정 기획서 7-1). 확인할 수 없으면 허용으로 본다(권한 문제로 잘못 안내하지 않는다).
async function hasAccess(pattern) {
  if (!pattern) return true;
  try { return !!(await chrome.permissions.contains({ origins: [pattern] })); } catch (e) { return true; }
}
async function accessOffFor(url) {
  const pattern = MBX.originPatternFor(url);
  return !!pattern && !(await hasAccess(pattern));
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
// 값은 { lang: 언어 코드, on: 불리언 } (UI 수정 기획서 4-4). on이 불리언이 아니면 거부한다.
handlers.SET_THREAD_LANG = async function (msg) {
  if (typeof msg.threadId !== 'string' || !msg.threadId || !MBX.isValidThreadLang(msg.lang) || typeof msg.on !== 'boolean') {
    return { ok: false, code: 'REJECTED' };
  }
  const { threadLangs } = await loadState(['threadLangs']);
  await saveState({ threadLangs: MBX.setThreadLang(threadLangs, msg.threadId, msg.lang, msg.on, Date.now(), MBX.THREAD_LANG_CAP) });
  return { ok: true };
};

handlers.GET_THREAD_LANG = async function (msg) {
  if (typeof msg.threadId !== 'string' || !msg.threadId) return { ok: false, code: 'REJECTED' };
  const st = await loadState(['threadLangs', 'settings']);
  const full = Object.assign({}, MBX.DEFAULT_SETTINGS, st.settings);
  const t = MBX.getThreadLang(st.threadLangs, msg.threadId, full.sendTargetLang, MBX.isValidThreadLang);
  return { threadId: msg.threadId, lang: t.lang, on: t.on };
};

// 설정 화면의 특정 메뉴 열기(UI 수정 기획서 7-3). openOptionsPage 는 해시를 붙일 수 없으므로
// 메뉴를 storage.session 에 적어 두면 설정 화면이 읽고 지운다. 이미 열린 설정 탭은 앞으로 온다.
const OPTIONS_SECTIONS = ['start', 'slack', 'translate', 'quick', 'help'];
handlers.OPEN_OPTIONS = async function (msg) {
  const section = OPTIONS_SECTIONS.indexOf(msg && msg.section) >= 0 ? msg.section : 'start';
  try { await chrome.storage.session.set({ pendingOptionsSection: section }); } catch (e) { console.debug('pending section failed'); }
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
    if (await accessOffFor(req.url)) return { ok: false, error: MBX.PERMISSION_OFF };
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
  if (!r.ok) {
    if (r.error.code === 'BAD_KEY' || r.error.code === 'QUOTA') await recordDeepl({ ok: false, code: r.error.code });
    return fail(r.error);
  }
  const t = r.json && r.json.translations && r.json.translations[0];
  if (!t || typeof t.text !== 'string') return fail(MBX.mapDeeplError(0));
  await recordDeepl({ ok: true, code: '' }); // used, limit 은 그대로 둔다
  return { ok: true, text: t.text, detectedLang: t.detected_source_language };
};

handlers.CHECK_DEEPL_KEY = async function () {
  const key = await getDeeplKey();
  if (!key) return fail(MBX.NO_KEY);
  const r = await deeplFetch(MBX.buildUsageRequest(key));
  const now = Date.now();
  if (!r.ok) {
    await recordDeepl({ checkedAt: now, ok: false, code: r.error.code });
    return fail(r.error);
  }
  const used = Number(r.json.character_count) || 0;
  const limit = Number(r.json.character_limit) || 0;
  await recordDeepl({ checkedAt: now, ok: true, code: '', used: used, limit: limit });
  return { ok: true, used: r.json.character_count, limit: r.json.character_limit };
};

// DeepL 결과를 statusInfo.deepl 에 반영한다(7-2).
function recordDeepl(part) {
  return runSerial(function () {
    return patchStatusInfo(function (si) { si.deepl = Object.assign(si.deepl, part); return si; });
  }).catch(function () { console.debug('deepl status save failed'); });
}

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
    })
    .then(releaseAndFlush) // 처리한 메시지마다 보류 해제와 전송 대기 항목을 확인한다(응답은 이미 보냈다)
    .catch(function () { console.debug('flush after message failed'); });
  return true;
});

// ---- content script 연결(port)과 감지 담당 탭(기획서 6-1 "감지 담당 탭") ----
// port별 정보는 캐시일 뿐이다(service worker가 종료되면 사라진다). 영속 상태는 저장소의 tabsSeen, watcherState.ownerTabId.
const ports = new Map(); // port -> { assetId, path, tabId, role }

function portIsContent(port) {
  // classifySender 와 같은 기준: sender.id, sender.tab.url 이 business.facebook.com 인 content 만 받는다.
  return MBX.classifySender(port.sender, chrome.runtime.id) === 'content';
}

function targetOf(full) {
  return typeof full.assetId === 'string' ? full.assetId.trim() : '';
}

// role 계산은 이 함수 한 곳에서만 한다. 대상 계정의 탭이면 담당(chooseOwner 결과)인지에 따라 owner/standby.
function computeRole(fullSettings, info, ownerTabId) {
  const r = MBX.roleFor(fullSettings, info.assetId);
  if (r !== 'standby') return r;
  return info.tabId !== null && info.tabId === ownerTabId ? 'owner' : 'standby';
}

async function readFullSettings() {
  const { settings } = await loadState(['settings']);
  return Object.assign({}, MBX.DEFAULT_SETTINGS, settings);
}

function readTabs(v) { return Array.isArray(v) ? v.filter(function (t) { return t && typeof t.tabId === 'number'; }) : []; }

// 이하 tabsSeen·담당 함수는 모두 직렬 큐 안에서 부른다.
// alive 가 false(실패 신호)면 계정·경로만 갱신하고 lastSeen 은 그대로 둔다(처음 보는 탭이면 now).
// 담당 유지 기준인 "생존 신호"는 정상 신호와 HELLO 뿐이다. 실패 신호로 lastSeen 을 갱신하면
// 실패 중인 담당이 90초 초과로 물러나지 않아 정상인 대기 탭으로 넘어가지 못한다.
async function touchTab(tabId, assetId, path, now, alive) {
  const { tabsSeen } = await loadState(['tabsSeen']);
  const all = readTabs(tabsSeen);
  const prev = all.find(function (t) { return t.tabId === tabId; });
  const tabs = all.filter(function (t) { return t.tabId !== tabId; });
  const lastSeen = alive === false && prev ? (prev.lastSeen || 0) : now;
  tabs.push({ tabId: tabId, assetId: assetId, path: path, lastSeen: lastSeen });
  const patch = { tabsSeen: tabs };
  // 수신함이었던 탭을 기억한다. 로그인·보안 확인 화면으로 바뀌어 다시 로드되면 port 끊김으로 tabsSeen 에서는 지워지므로 따로 둔다.
  const { watcherState } = await loadState(['watcherState']);
  const ws = watcherState || defaultState().watcherState;
  const ids = MBX.rememberInboxTab(ws.inboxTabIds, tabId, path);
  if (ids !== ws.inboxTabIds) patch.watcherState = Object.assign({}, ws, { inboxTabIds: ids });
  await saveState(patch);
}

async function forgetTab(tabId) {
  const { tabsSeen } = await loadState(['tabsSeen']);
  const before = readTabs(tabsSeen);
  const tabs = before.filter(function (t) { return t.tabId !== tabId; });
  if (tabs.length !== before.length) await saveState({ tabsSeen: tabs });
}

// 바뀐 role 만 알린다. HELLO 응답 전(role === null)인 port 는 HELLO 응답이 role 을 준다.
function pushRoles(full, ownerTabId) {
  ports.forEach(function (info, p) {
    if (info.role === null) return;
    const role = computeRole(full, info, ownerTabId);
    if (role === info.role) return;
    info.role = role;
    try { p.postMessage({ type: 'WATCHER_ROLE', role: role }); } catch (e) { ports.delete(p); }
  });
}

// tabsSeen 정리 → chooseOwner → 바뀌었으면 저장 → 바뀐 role 알림. 담당 탭 번호(없으면 null)를 돌려준다.
// 정리 기준: 이 service worker 에 연결(port)이 살아 있거나 OWNER_TIMEOUT_MS 안에 소식이 있었던 탭만 남긴다.
// (service worker 재시작 직후에는 port 가 비어 있지만 content script 가 1초 뒤 다시 연결해 HELLO 를 보낸다.)
async function recomputeOwner(now) {
  const st = await loadState(['settings', 'tabsSeen', 'watcherState']);
  const full = Object.assign({}, MBX.DEFAULT_SETTINGS, st.settings);
  const ws = st.watcherState || defaultState().watcherState;
  const live = new Set();
  ports.forEach(function (info) { if (info.tabId !== null) live.add(info.tabId); });
  const before = readTabs(st.tabsSeen);
  // HELLO 를 마친 port 인데 tabsSeen 에 없으면(시작 시 초기화와 순서가 엇갈린 경우) port 정보로 되살린다.
  const restored = before.slice();
  ports.forEach(function (info) {
    if (info.tabId === null || !info.path || restored.some(function (t) { return t.tabId === info.tabId; })) return;
    restored.push({ tabId: info.tabId, assetId: info.assetId, path: info.path, lastSeen: now });
  });
  let tabs = restored.filter(function (t) { return live.has(t.tabId) || now - (t.lastSeen || 0) <= MBX.OWNER_TIMEOUT_MS; });
  const prev = typeof ws.ownerTabId === 'number' ? ws.ownerTabId : null;
  const owner = MBX.chooseOwner(prev, tabs, targetOf(full), now, MBX.OWNER_TIMEOUT_MS);
  // 새 담당은 지금부터 시간을 센다(오래전 HELLO 시각 그대로면 다음 계산에서 곧바로 시간 초과가 된다).
  if (owner !== null && owner !== prev) {
    tabs = tabs.map(function (t) { return t.tabId === owner ? Object.assign({}, t, { lastSeen: now }) : t; });
  }
  const patch = {};
  if (JSON.stringify(tabs) !== JSON.stringify(before)) patch.tabsSeen = tabs;
  if (owner !== prev) {
    patch.watcherState = Object.assign({}, ws, { ownerTabId: owner });
    console.debug('watcher owner', owner);
  }
  if (Object.keys(patch).length) await saveState(patch);
  pushRoles(full, owner);
  return owner;
}

async function handleHello(port, msg) {
  if (!msg || msg.type !== 'HELLO' || !MBX.isAllowed('HELLO', 'content') || !ports.has(port)) return;
  const info = ports.get(port);
  const now = Date.now();
  info.assetId = typeof msg.asset_id === 'string' ? msg.asset_id : '';
  info.path = typeof msg.path === 'string' ? msg.path : '';
  info.role = null; // 이 port 의 role 은 아래 HELLO 응답으로 준다(WATCHER_ROLE 중복 방지)
  if (info.tabId !== null) await touchTab(info.tabId, info.assetId, info.path, now);
  const owner = await recomputeOwner(now);
  const full = await readFullSettings();
  info.role = computeRole(full, info, owner);
  // 비밀값은 절대 넣지 않는다.
  port.postMessage({ type: 'HELLO_REPLY', settings: MBX.publicSettings(full), role: info.role });
}

chrome.runtime.onConnect.addListener(function (port) {
  if (!portIsContent(port)) { port.disconnect(); return; }
  const tabId = port.sender.tab && typeof port.sender.tab.id === 'number' ? port.sender.tab.id : null;
  ports.set(port, { assetId: '', path: '', tabId: tabId, role: null });
  port.onDisconnect.addListener(function () {
    ports.delete(port);
    runSerial(async function () {
      // 새로고침이면 새 port 가 먼저 붙었을 수 있다. 같은 탭의 다른 port 가 살아 있으면 지우지 않는다.
      let other = false;
      ports.forEach(function (info) { if (info.tabId === tabId) other = true; });
      if (tabId !== null && !other) await forgetTab(tabId);
      await recomputeOwner(Date.now());
    }).catch(function () { console.debug('disconnect handling failed'); });
  });
  port.onMessage.addListener(function (msg) {
    runSerial(function () { return handleHello(port, msg); })
      .catch(function () { console.debug('hello failed'); })
      .then(releaseAndFlush);
  });
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  // 닫힌 탭의 port 가 아직 Map 에 남아 있으면 recomputeOwner 가 port 정보로 tabsSeen 을 되살리므로 먼저 지운다.
  ports.forEach(function (info, p) { if (info.tabId === tabId) ports.delete(p); });
  runSerial(async function () {
    await forgetTab(tabId);
    const { watcherState } = await loadState(['watcherState']);
    const ws = watcherState || defaultState().watcherState;
    const ids = MBX.forgetInboxTab(ws.inboxTabIds, tabId);
    if (ids !== ws.inboxTabIds) await saveState({ watcherState: Object.assign({}, ws, { inboxTabIds: ids }) });
    await recomputeOwner(Date.now());
  }).catch(function () { console.debug('tab removed handling failed'); });
});

// 탭 번호는 브라우저 재시작·확장 다시 로드 뒤에 이어지지 않는다. 그때만 지운다(service worker 재시작에는 불리지 않으므로 담당이 유지된다).
function resetTabs() {
  runSerial(async function () {
    const { watcherState } = await loadState(['watcherState']);
    const ws = watcherState || defaultState().watcherState;
    await saveState({ tabsSeen: [], watcherState: Object.assign({}, ws, { ownerTabId: null, inboxTabIds: [] }) });
  }).catch(function () { console.debug('tab reset failed'); });
}
chrome.runtime.onStartup.addListener(resetTabs);
chrome.runtime.onInstalled.addListener(resetTabs);

// settings, quickReplies 가 바뀌면 연결된 탭에 알리고, 담당을 다시 정해 바뀐 role 도 알린다.
// (알림 대상 지정 직후에는 탭이 HELLO 를 다시 보내지 않으므로 여기서 tabsSeen 으로 담당을 정한다.)
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local' || (!changes.settings && !changes.quickReplies)) return;
  runSerial(async function () {
    const full = await readFullSettings();
    if (changes.settings) {
      const st = await loadState(['watcherState', 'lastError', 'statusInfo']);
      const patch = {};
      // 키나 Webhook 주소가 바뀌면 상태 표시용 기록을 되돌린다(7-2). 값은 비교만 하고 어디에도 남기지 않는다.
      const was = changes.settings.oldValue || {};
      const now = changes.settings.newValue || {};
      if ((was.deeplApiKey || '') !== (now.deeplApiKey || '') || (was.slackWebhookUrl || '') !== (now.slackWebhookUrl || '')) {
        const si = Object.assign(defaultStatusInfo(), st.statusInfo);
        if ((was.deeplApiKey || '') !== (now.deeplApiKey || '')) si.deepl = defaultDeeplStatus();
        if ((was.slackWebhookUrl || '') !== (now.slackWebhookUrl || '')) si.slackTestOkAt = 0;
        patch.statusInfo = si;
      }
      // 알림 대상 계정이 바뀌면 이전 계정의 배지 기준값을 버린다(잘못된 "자리 비운 사이" 알림 방지). compareBadges 도 같은 확인을 한다.
      const ws = st.watcherState || defaultState().watcherState;
      const ws2 = MBX.resetChannelsForAsset(ws, targetOf(full));
      if (ws2 !== ws) patch.watcherState = ws2;
      // 설정 필요 상태가 더는 맞지 않으면(Slack 끔, 주소 입력) 지운다. 다른 오류는 그대로 둔다.
      if (MBX.staleNotConfigured(st.lastError, full)) patch.lastError = null;
      if (Object.keys(patch).length) await saveState(patch);
      if ('lastError' in patch) setActionBadge('');
    }
    const msg = { type: 'SETTINGS_CHANGED', settings: MBX.publicSettings(full), quickRepliesChanged: !!changes.quickReplies };
    ports.forEach(function (info, p) {
      try { p.postMessage(msg); } catch (e) { ports.delete(p); }
    });
    await recomputeOwner(Date.now());
  }).catch(function () { console.debug('settings push failed'); });
});

// ---- 배지 기준값 판단(기획서 6-1 신호 1) ----
// Task 11에서 결합 로직에 연결한다. 지금은 메시지 본문 없이 채널과 건수만 남긴다.
// 호출자가 직렬 큐 안에 있어야 한다(핸들러 안에서 부른다). 큐를 다시 부르면 교착되므로 runSerial 을 쓰지 않는다.
// Slack 이 꺼져 있으면 조용히 건너뛴다(Ruling 13). 켜져 있는데 주소가 없으면 enqueue 와 같이 대기열에 넣지 않는다
// (보류 항목과 보충 기록도 만들지 않는다). 설정 필요 상태는 lastError 와 배지 '!'.
async function routeInQueue(routeFn) {
  const st = await loadState(['settings', 'slackQueue', 'recentCountAlerts']);
  const full = Object.assign({}, MBX.DEFAULT_SETTINGS, st.settings);
  const cfg = MBX.slackConfigState(full);
  if (cfg === 'disabled') return false; // Ruling 13: Slack 끔은 오류가 아니다. 조용히 건너뛴다
  if (cfg === 'missing') { await markNotConfigured(); return false; }
  const before = Array.isArray(st.slackQueue) ? st.slackQueue : [];
  const next = routeFn({ queue: before, recent: Array.isArray(st.recentCountAlerts) ? st.recentCountAlerts : [] });
  await saveState({ slackQueue: next.queue, recentCountAlerts: next.recent });
  const held = function (q) { return q.status === 'hold'; };
  if (next.queue.filter(held).length > before.filter(held).length) scheduleHoldRelease();
  return true;
}

async function onBadgeEvent(ev) {
  console.debug('badge event', ev.channel, ev.count, ev.kind);
  await routeInQueue(function (st) { return MBX.routeBadgeEvent(st, ev, Date.now(), newItemId); });
}

// BADGE_STATE 와 HEARTBEAT 의 badges 가 함께 쓰는 비교 경로. 직렬 큐 안에서 부른다. 형식이 틀리면 false.
async function compareBadges(report) {
  const st = await loadState(['watcherState', 'settings']);
  const ws = st.watcherState || defaultState().watcherState;
  const full = Object.assign({}, MBX.DEFAULT_SETTINGS, st.settings);
  // 기준값이 다른 계정 것이면 먼저 버린다(설정 변경 알림보다 보고가 먼저 처리돼도 안전하다).
  const r = MBX.handleBadgeState(ws, report, Date.now(), targetOf(full));
  if (r.state === ws) return false;
  await saveState({ watcherState: r.state });
  for (const ev of r.events) await onBadgeEvent(ev);
  return true;
}

function senderTabId(sender) {
  return sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
}

// 직렬 큐 안에서 실행된다(onMessage 라우터). 대상 계정이고 보낸 탭이 담당일 때만 처리한다.
// 담당은 저장소의 ownerTabId 로 판단한다(service worker 재시작 직후에는 port 가 비어 있다).
handlers.BADGE_STATE = async function (msg, sender) {
  const st = await loadState(['watcherState', 'settings']);
  const full = Object.assign({}, MBX.DEFAULT_SETTINGS, st.settings);
  const ws = st.watcherState || defaultState().watcherState;
  const tabId = senderTabId(sender);
  if (!MBX.assetMatches(full, msg) || tabId === null || tabId !== ws.ownerTabId) return { ok: false, code: 'REJECTED' };
  if (!(await compareBadges(msg))) return { ok: false, code: 'REJECTED' }; // 형식이 틀린 보고
  return { ok: true };
};

// ---- 목록 후보(기획서 6-1 신호 2) ----
// Task 11에서 결합 로직에 연결한다. 지금은 본문 없이 채널만 남긴다.
async function onListCandidate(cand) {
  console.debug('list candidate', cand.channel);
  await routeInQueue(function (st) { return MBX.routeCandidate(st, cand, Date.now(), newItemId); });
}

// 직렬 큐 안에서 실행된다. 담당 여부와 관계없이 대상 계정의 탭이면 받는다.
handlers.LIST_CANDIDATE = async function (msg) {
  const full = await readFullSettings();
  if (!MBX.assetMatches(full, msg) || !MBX.validCandidateMsg(msg)) return { ok: false, code: 'REJECTED' };
  const at = (typeof msg.at === 'number' && Number.isFinite(msg.at)) ? msg.at : Date.now();
  await onListCandidate({ channel: msg.channel, sender: msg.sender, preview: msg.preview, time: msg.time, at: at });
  return { ok: true };
};

// ---- 생존 신호와 감지 중단 경고(기획서 6-5) ----
const TEXT_STOPPED = '감지가 중단되었습니다. 수신함 탭을 확인하세요';
const TEXT_RESUMED = '감지가 재개되었습니다';
const REASON_TEXT = {
  login: '로그인/보안 확인 화면 때문에 감지가 중단되었습니다. 수신함 탭에서 로그인 상태를 확인하세요',
  selector: '수신함 화면 요소를 찾지 못해 감지가 중단되었습니다. 수신함 탭을 새로고침하고, 계속되면 확장 프로그램 점검이 필요합니다',
  no_asset_id: '계정 정보(asset_id)를 읽지 못해 감지가 중단되었습니다. 수신함 탭을 새로고침하세요'
};

function systemItem(text) {
  return { type: 'system', channel: '', count: 0, kind: 'new', manualHint: false, sender: null, preview: null, time: null, text: text };
}

// 직렬 큐 안에서 실행된다. 신호를 보낸 탭은 tabsSeen 에 반영하고 담당을 다시 정한다(계정 전환·수신함 이탈이면 넘긴다).
// - ok: true 는 담당 탭 것만 lastHeartbeat 를 갱신한다. badges 가 있으면 BADGE_STATE 와 같은 경로로 비교한다.
// - ok: false 는 원인(reason)별로 재개 전까지 1회 경고한다. 담당 탭이 보냈거나, 담당이 없을 때만(정상인 담당이 있으면
//   다른 탭의 실패는 감지에 영향이 없다). asset_id 를 못 읽은 탭은 담당이 될 수 없으므로 "담당 없음"일 때 이 경로로 알린다.
handlers.HEARTBEAT = async function (msg, sender) {
  const tabId = senderTabId(sender);
  if (tabId === null || typeof msg.ok !== 'boolean' || typeof msg.path !== 'string' || typeof msg.asset_id !== 'string') {
    return { ok: false, code: 'REJECTED' };
  }
  const now = Date.now();
  await touchTab(tabId, msg.asset_id, msg.path, now, msg.ok);
  const owner = await recomputeOwner(now);
  const full = await readFullSettings();
  if (!targetOf(full)) return { ok: true };

  if (msg.ok) {
    if (tabId !== owner || !MBX.assetMatches(full, msg)) return { ok: true };
    const { watcherState } = await loadState(['watcherState']);
    const ws = watcherState || defaultState().watcherState;
    const r = MBX.onHeartbeat(ws, now);
    const hadFail = Array.isArray(ws.failAlerts) && ws.failAlerts.length > 0;
    await saveState({ watcherState: Object.assign({}, r.ws, { failAlerts: [] }) });
    if (r.alert === 'resumed' || hadFail) await enqueue(systemItem(TEXT_RESUMED));
    if (msg.badges) await compareBadges({ badges: msg.badges, initial: false, userActionRecent: false, at: now });
    return { ok: true };
  }

  if (!Object.prototype.hasOwnProperty.call(REASON_TEXT, msg.reason)) return { ok: true };
  if (owner !== null && tabId !== owner) return { ok: true };
  const { watcherState } = await loadState(['watcherState']);
  const ws = watcherState || defaultState().watcherState;
  // 수신함 탭의 실패만 경고한다. 관련 없는 Business 화면(비밀번호 입력란이 있는 설정 화면 등)은 무시한다.
  const wasInbox = Array.isArray(ws.inboxTabIds) && ws.inboxTabIds.indexOf(tabId) >= 0;
  if (!MBX.failureReportAllowed(msg.reason, msg.path, wasInbox)) return { ok: true };
  const sent = Array.isArray(ws.failAlerts) ? ws.failAlerts : [];
  if (sent.indexOf(msg.reason) >= 0) return { ok: true };
  console.debug('watcher failure alert', msg.reason);
  await saveState({ watcherState: Object.assign({}, ws, { failAlerts: sent.concat([msg.reason]) }) });
  await enqueue(systemItem(REASON_TEXT[msg.reason]));
  return { ok: true };
};

// 1분 알람. 담당을 다시 정하고(생존 신호 90초 초과면 넘긴다) 중단 여부를 판단한다. 직렬 큐 안에서 부른다.
async function alarmTick() {
  const now = Date.now();
  await recomputeOwner(now);
  const st = await loadState(['watcherState', 'settings']);
  const full = Object.assign({}, MBX.DEFAULT_SETTINGS, st.settings);
  const r = MBX.watchdogTick(st.watcherState || defaultState().watcherState, targetOf(full), now);
  await saveState({ watcherState: r.ws });
  if (r.alert === 'stopped') {
    console.debug('watcher stopped alert');
    await enqueue(systemItem(TEXT_STOPPED));
  }
}

// ---- options 페이지용 ----
// 연결된 수신함 탭들이 HELLO·HEARTBEAT로 알려 온 asset_id 를 쓴다(chrome.tabs로 주소를 조회하지 않는다).
// msg.assetId 가 있으면(MULTIPLE 뒤 사용자가 고른 값) 그 값이 목록에 있을 때만 저장한다.
handlers.SET_ASSET_FROM_OPEN_TAB = async function (msg) {
  await recomputeOwner(Date.now()); // 끊긴 탭 정리
  const { tabsSeen } = await loadState(['tabsSeen']);
  const ids = [];
  readTabs(tabsSeen).forEach(function (t) {
    if (typeof t.path === 'string' && t.path.indexOf('/latest/inbox') === 0 && typeof t.assetId === 'string' && t.assetId &&
        ids.indexOf(t.assetId) < 0) ids.push(t.assetId);
  });
  if (!ids.length) return { ok: false, code: 'NO_INBOX_TAB' };
  let pick = null;
  if (typeof msg.assetId === 'string' && msg.assetId) {
    if (ids.indexOf(msg.assetId) < 0) return { ok: false, code: 'REJECTED' };
    pick = msg.assetId;
  } else if (ids.length === 1) {
    pick = ids[0];
  } else {
    return { ok: false, code: 'MULTIPLE', assetIds: ids };
  }
  const st = await loadState(['settings', 'watcherState']);
  const patch = { settings: Object.assign({}, MBX.DEFAULT_SETTINGS, st.settings, { assetId: pick }) };
  // 대상 계정이 바뀌면 이전 계정의 배지 기준값을 같은 저장에서 버린다.
  const ws = st.watcherState || defaultState().watcherState;
  const ws2 = MBX.resetChannelsForAsset(ws, pick);
  if (ws2 !== ws) patch.watcherState = ws2;
  await saveState(patch);
  return { ok: true, assetId: pick };
};

// 설정 화면 상태 표시(UI 수정 기획서 6-3, 7-2). DeepL·Slack 으로 요청을 보내지 않는다. 비밀값은 넣지 않는다.
handlers.GET_STATUS = async function () {
  const st = await loadState(['watcherState', 'lastSend', 'slackQueue', 'lastError', 'settings', 'statusInfo']);
  const ws = st.watcherState || {};
  const full = Object.assign({}, MBX.DEFAULT_SETTINGS, st.settings);
  const queue = Array.isArray(st.slackQueue) ? st.slackQueue : [];
  const si = Object.assign(defaultStatusInfo(), st.statusInfo);
  const key = typeof full.deeplApiKey === 'string' ? full.deeplApiKey.trim() : '';
  const fails = Array.isArray(ws.failAlerts) ? ws.failAlerts : [];
  const permissions = {};
  const allowed = await Promise.all(MBX.HOST_ORIGINS.map(hasAccess));
  MBX.HOST_ORIGINS.forEach(function (o, i) { permissions[o] = allowed[i]; });
  return {
    lastHeartbeat: typeof ws.lastHeartbeat === 'number' ? ws.lastHeartbeat : 0,
    lastSend: st.lastSend || null,
    queueLength: queue.length,
    lastError: st.lastError || null,
    assetId: targetOf(full),
    ownerTabId: typeof ws.ownerTabId === 'number' ? ws.ownerTabId : null,
    permissions: permissions,
    deepl: Object.assign(defaultDeeplStatus(), si.deepl, { hasKey: !!key, free: /:fx$/.test(key) }),
    slackTestOkAt: typeof si.slackTestOkAt === 'number' ? si.slackTestOkAt : 0,
    webhookSet: typeof full.slackWebhookUrl === 'string' && full.slackWebhookUrl.trim() !== '',
    slackEnabled: full.slackEnabled !== false,
    retryCount: queue.filter(function (it) { return it && it.attempts >= 1; }).length,
    detect: { everSeen: !!ws.everSeen, failing: fails.length > 0, failReason: fails.length ? fails[fails.length - 1] : null }
  };
};

// ---- Slack 전송 대기열(기획서 6-3, 6-4) ----
const ALARM_NAME = 'mbx-tick';
const SLACK_TIMEOUT_MS = 10000;
const NOT_CONFIGURED_MESSAGE = 'Slack Webhook 주소가 비어 있습니다. 설정에서 확인하세요';
const DISABLED_MESSAGE = 'Slack 알림이 꺼져 있습니다. 설정에서 "Slack 알림 사용"을 켜세요';

function newItemId() {
  return (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'q-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

function setActionBadge(text) {
  try { chrome.action.setBadgeText({ text: text }); } catch (e) { console.debug('badge failed'); }
}

// 오류 기록에는 Webhook 주소와 메시지 본문을 넣지 않는다.
function slackError(code, message, status) {
  return { source: 'slack', code: code, message: message, status: status === undefined ? null : status, at: Date.now() };
}

// 이미 설정 필요 상태로 기록돼 있으면 다시 쓰지 않는다(이벤트마다 lastError 를 다시 쓰지 않는다).
async function markNotConfigured() {
  const { lastError } = await loadState(['lastError']);
  if (MBX.needsNotConfiguredWrite(lastError)) await saveState({ lastError: slackError('NOT_CONFIGURED', NOT_CONFIGURED_MESSAGE) });
  setActionBadge('!');
}

// 호출자가 직렬 큐 안에 있어야 한다(저장소 읽기·쓰기를 가른다). 큐 밖에서는 runSerial(() => enqueue(item))로 부른다.
// 대기열에 넣었으면 'queued', Slack 이 꺼져 있으면 'disabled'(조용히 건너뜀, Ruling 13),
// 주소가 비어 있으면 'missing'(lastError 에 기록).
async function enqueue(item) {
  const st = await loadState(['settings', 'slackQueue']);
  const full = Object.assign({}, MBX.DEFAULT_SETTINGS, st.settings);
  const cfg = MBX.slackConfigState(full);
  if (cfg === 'disabled') return 'disabled';
  if (cfg === 'missing') {
    await markNotConfigured();
    return 'missing';
  }
  const entry = Object.assign({
    id: newItemId(), createdAt: Date.now(), status: 'ready', holdUntil: null, attempts: 0, nextTryAt: 0
  }, item);
  await saveState({ slackQueue: (Array.isArray(st.slackQueue) ? st.slackQueue : []).concat([entry]) });
  return 'queued';
}

async function postSlack(url, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, SLACK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ctrl.signal
    });
    const ra = Number(res.headers.get('Retry-After'));
    return { status: res.status, retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : null };
  } catch (e) {
    return { status: 0, retryAfterSec: null }; // 네트워크 오류, 시간 초과
  } finally {
    clearTimeout(timer);
  }
}

// 채널별 현재 배지 숫자(읽지 않은 대화 수, UI 수정 기획서 12장). 알림을 만들 때가 아니라 내보내는 시점의 값을 쓴다.
// 아직 배지 값을 받지 못한 채널은 null(알림에는 '-'로 적힌다).
function unreadCounts(ws) {
  const ch = (ws && ws.channels) || {};
  const out = {};
  ['instagram_direct', 'wec'].forEach(function (c) {
    out[c] = ch[c] && ch[c].known && typeof ch[c].base === 'number' ? ch[c].base : null;
  });
  return out;
}

// 1단계(큐 안): 만료 폐기, 중복 폐기, 보낼 항목 선택. 2단계(큐 밖): fetch. 3단계(큐 안): 결과 반영.
async function flushPass(now) {
  const picked = await runSerial(async function () {
    const st = await loadState(['slackQueue', 'sentKeys', 'settings', 'lastError', 'watcherState']);
    const full = Object.assign({}, MBX.DEFAULT_SETTINGS, st.settings);
    const sentKeys = MBX.pruneSentKeys(Array.isArray(st.sentKeys) ? st.sentKeys : [], now);
    let queue = (Array.isArray(st.slackQueue) ? st.slackQueue : []).filter(function (it) { return now - it.createdAt < MBX.QUEUE_TTL_MS; });
    const patch = { sentKeys: sentKeys };
    const out = [];
    const seen = {};
    queue = queue.filter(function (it) {
      if (it.status !== 'ready' || it.nextTryAt > now) return true;
      const key = MBX.dedupKey(it, now);
      if (it.type !== 'system' && (MBX.isDuplicate(sentKeys, key, now) || seen[key])) return false; // 중복은 폐기
      seen[key] = true;
      out.push({ item: it, key: key });
      return true;
    });
    const cfg = MBX.slackConfigState(full);
    if (out.length && cfg !== 'ok') {
      // 대기 중에 Slack 이 꺼졌거나 주소가 지워졌다. 보낼 곳이 없으므로 해당 항목을 버린다.
      // 꺼짐은 조용히(Ruling 13), 주소 없음만 설정 필요 상태를 남긴다(이미 같은 상태면 다시 쓰지 않는다).
      const drop = {};
      out.forEach(function (o) { drop[o.item.id] = true; });
      patch.slackQueue = queue.filter(function (it) { return !drop[it.id]; });
      if (cfg === 'missing' && MBX.needsNotConfiguredWrite(st.lastError)) patch.lastError = slackError('NOT_CONFIGURED', NOT_CONFIGURED_MESSAGE);
      await saveState(patch);
      if (cfg === 'missing') setActionBadge('!');
      return { list: [], url: '', settings: full };
    }
    patch.slackQueue = queue;
    await saveState(patch);
    return { list: out, url: full.slackWebhookUrl, settings: full, counts: unreadCounts(st.watcherState) };
  });
  if (!picked.list.length) return;

  // 큐 밖: 직렬로 하나씩 보낸다(Slack Webhook 은 초당 1건 안팎이 기준이다).
  // 429 나 네트워크 오류가 나면 나머지는 보내지 않고 같은 nextTryAt 으로 재시도에 맡긴다(시도하지 않았으므로 attempts 는 그대로).
  const results = [];
  let stop = null;
  for (const o of picked.list) {
    if (stop) {
      results.push({ id: o.item.id, key: o.key, system: o.item.type === 'system', attempts: o.item.attempts || 0, status: stop.status, outcome: 'retry', nextTryAt: stop.nextTryAt });
      continue;
    }
    const r = await postSlack(picked.url, MBX.buildSlackPayload(o.item, picked.settings, now, picked.counts));
    console.debug('slack send', r.status);
    const attempts = o.item.attempts || 0;
    const res = { id: o.item.id, key: o.key, system: o.item.type === 'system', attempts: attempts, status: r.status, outcome: MBX.classifyStatus(r.status) };
    if (res.outcome === 'retry') {
      if (r.status === 0 && await accessOffFor(picked.url)) res.accessOff = true;
      res.attempts = attempts + 1;
      res.nextTryAt = now + MBX.nextRetryDelayMs(attempts, r.retryAfterSec);
      if (r.status === 0 || r.status === 429) stop = { status: r.status, nextTryAt: res.nextTryAt };
    }
    results.push(res);
  }

  await runSerial(async function () {
    const st = await loadState(['slackQueue', 'sentKeys', 'lastError']);
    let queue = Array.isArray(st.slackQueue) ? st.slackQueue : [];
    let sentKeys = Array.isArray(st.sentKeys) ? st.sentKeys : [];
    const patch = {};
    let badge = null;
    let lastError = st.lastError;
    results.forEach(function (r) {
      patch.lastSend = { at: now, outcome: r.outcome, status: r.status };
      if (r.outcome === 'ok') {
        queue = queue.filter(function (it) { return it.id !== r.id; });
        if (!r.system) sentKeys = sentKeys.concat([{ key: r.key, at: now }]);
        if (lastError && lastError.source === 'slack') { lastError = null; badge = ''; }
      } else if (r.outcome === 'config') {
        queue = queue.filter(function (it) { return it.id !== r.id; });
        lastError = slackError('CONFIG', '설정 오류(HTTP ' + r.status + '): Webhook 주소를 확인하세요. 재시도하지 않습니다', r.status);
        badge = '!';
      } else {
        // 사이트 액세스 권한이 꺼져 실패했으면 대기열에 그대로 두고 이유를 기록한다(7-1).
        if (r.accessOff) { lastError = slackError(MBX.PERMISSION_OFF.code, MBX.PERMISSION_OFF.message, 0); badge = '!'; }
        queue = queue.map(function (it) {
          return it.id !== r.id ? it : Object.assign({}, it, {
            attempts: r.attempts, nextTryAt: r.nextTryAt
          });
        });
      }
    });
    patch.slackQueue = queue;
    patch.sentKeys = sentKeys;
    if (lastError !== st.lastError) patch.lastError = lastError;
    await saveState(patch);
    if (badge !== null) setActionBadge(badge);
  });
}

// 동시에 두 번 돌면 같은 항목을 둘 다 보낼 수 있다(선택과 결과 반영 사이에 fetch 가 끼어 있기 때문).
// 그래서 모듈 수준의 진행 중 약속 하나로 합친다. 실행 중에 다시 불리면 끝난 뒤 한 번 더 돈다.
// 저장소에 "전송 중" 표시를 두지 않는 이유: service worker 가 fetch 도중 종료되면 표시가 남아 항목이 영원히 막힌다.
// 종료되면 진행 중 약속도 함께 사라지므로, 새 인스턴스는 그 항목을 다시 보낸다(중복이 누락보다 낫다).
let flushing = null;
let flushDirty = false;
function flushQueue(now) {
  if (flushing) { flushDirty = true; return flushing; }
  flushing = (async function () {
    let t = typeof now === 'number' ? now : Date.now();
    try {
      do {
        flushDirty = false;
        try { await flushPass(t); } catch (e) { console.debug('flush failed'); }
        t = Date.now();
      } while (flushDirty);
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

// 테스트 메시지는 대기열에 넣지 않고 바로 보낸다. 실패하면 그 자리에서 실패로 알리고 끝낸다(재시도하지 않는다).
// 대기열을 거치면 연결이 막혀 있던 동안 누른 테스트가 나중에 한꺼번에 나간다.
handlers.SEND_TEST_SLACK = async function () {
  const st = await runSerial(function () { return loadState(['settings']); });
  const full = Object.assign({}, MBX.DEFAULT_SETTINGS, st.settings);
  const cfg = MBX.slackConfigState(full);
  if (cfg === 'disabled') return { ok: false, status: null, code: 'DISABLED', message: DISABLED_MESSAGE };
  if (cfg === 'missing') {
    await runSerial(markNotConfigured);
    return { ok: false, status: null, code: 'NOT_CONFIGURED', message: NOT_CONFIGURED_MESSAGE };
  }
  const now = Date.now();
  const item = {
    id: newItemId(), type: 'system', channel: '', count: 0, kind: 'new', manualHint: false, sender: null, preview: null, time: null,
    text: '[Meta Inbox Helper] 테스트 메시지입니다. 이 메시지가 보이면 Slack 연결이 정상입니다.',
    createdAt: now
  };
  const r = await postSlack(full.slackWebhookUrl, MBX.buildSlackPayload(item, full, now));
  console.debug('slack test send', r.status);
  const outcome = MBX.classifyStatus(r.status);
  const accessOff = r.status === 0 && await accessOffFor(full.slackWebhookUrl);
  await runSerial(async function () {
    const cur = await loadState(['lastError', 'statusInfo']);
    const patch = { lastSend: { at: now, outcome: outcome, status: r.status } };
    // 지금 Webhook 주소로 테스트에 성공한 기록(7-2). 주소를 바꾸면 settings 변경 처리에서 0으로 되돌린다.
    if (outcome === 'ok') patch.statusInfo = Object.assign(defaultStatusInfo(), cur.statusInfo, { slackTestOkAt: now });
    if (outcome === 'ok' && cur.lastError && cur.lastError.source === 'slack') patch.lastError = null;
    if (outcome === 'config') patch.lastError = slackError('CONFIG', '설정 오류(HTTP ' + r.status + '): Webhook 주소를 확인하세요. 재시도하지 않습니다', r.status);
    await saveState(patch);
    if ('lastError' in patch) setActionBadge(outcome === 'ok' ? '' : '!');
  });
  if (outcome === 'ok') return { ok: true, status: r.status };
  if (outcome === 'config') return { ok: false, status: r.status, code: 'CONFIG', message: '설정 오류(HTTP ' + r.status + '): Webhook 주소를 확인하세요' };
  if (accessOff) return { ok: false, status: r.status, code: MBX.PERMISSION_OFF.code, message: '전송하지 못했습니다. ' + MBX.PERMISSION_OFF.message };
  return { ok: false, status: r.status, code: 'FAILED', message: '전송하지 못했습니다(' + (r.status ? 'HTTP ' + r.status : '네트워크 오류') + '). 다시 보내려면 버튼을 한 번 더 누르세요' };
};

// ---- 보류 해제 ----
// 직렬 큐 안에서 holdUntil 이 지난 항목을 ready 로 바꾼다. 바뀐 것이 없으면 저장하지 않는다.
async function releaseDueStep() {
  const st = await loadState(['slackQueue', 'recentCountAlerts']);
  const queue = Array.isArray(st.slackQueue) ? st.slackQueue : [];
  const recent = Array.isArray(st.recentCountAlerts) ? st.recentCountAlerts : [];
  const next = MBX.releaseDue({ queue: queue, recent: recent }, Date.now());
  if (JSON.stringify(next.queue) === JSON.stringify(queue) && JSON.stringify(next.recent) === JSON.stringify(recent)) return;
  await saveState({ slackQueue: next.queue, recentCountAlerts: next.recent });
}

// 큐 밖에서 부른다(큐 안에서 부르면 교착된다).
function releaseAndFlush() {
  return runSerial(releaseDueStep)
    .catch(function () { console.debug('release failed'); })
    .then(function () { return flushQueue(Date.now()); })
    .catch(function () { console.debug('flush after release failed'); });
}

// 타이머는 service worker 가 종료되면 사라진다. 그래서 시작 시, 모든 메시지, 알람에서도 해제한다.
function scheduleHoldRelease() {
  setTimeout(releaseAndFlush, MBX.HOLD_MS + 50);
}

// ---- 알람과 시작 시 처리 ----
function ensureAlarm() {
  chrome.alarms.get(ALARM_NAME).then(function (a) {
    if (!a) chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  }).catch(function () { console.debug('alarm ensure failed'); });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name !== ALARM_NAME) return;
  runSerial(alarmTick)
    .catch(function () { console.debug('alarm tick failed'); })
    .then(releaseAndFlush);
});
ensureAlarm();
// 저장된 lastError 로 아이콘 배지를 맞춘다(service worker 가 다시 떠도 '!' 가 유지된다).
// 더는 맞지 않는 설정 필요 상태(Slack 끔, 주소 입력됨)는 여기서 지운다(Ruling 13).
runSerial(async function () {
  const st = await loadState(['lastError', 'settings']);
  let lastError = st.lastError;
  if (MBX.staleNotConfigured(lastError, Object.assign({}, MBX.DEFAULT_SETTINGS, st.settings))) {
    lastError = null;
    await saveState({ lastError: null });
  }
  setActionBadge(lastError ? '!' : '');
}).catch(function () { console.debug('badge sync failed'); });
releaseAndFlush();
