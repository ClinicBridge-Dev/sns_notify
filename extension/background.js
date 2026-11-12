importScripts('lib/constants.js', 'lib/settings.js', 'lib/serial.js', 'lib/deepl.js', 'lib/threadlang.js', 'lib/badge.js', 'lib/listcand.js', 'lib/slack.js');

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
    })
    .then(function () { return flushQueue(Date.now()); }) // 처리한 메시지마다 전송 대기 항목을 확인한다(응답은 이미 보냈다)
    .catch(function () { console.debug('flush after message failed'); });
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
  if (!MBX.assetMatches(full, msg)) return { ok: false, code: 'REJECTED' };
  const r = MBX.handleBadgeState(st.watcherState || defaultState().watcherState, msg, Date.now());
  if (r.state === (st.watcherState)) return { ok: false, code: 'REJECTED' }; // 형식이 틀린 보고
  await saveState({ watcherState: r.state });
  r.events.forEach(onBadgeEvent);
  return { ok: true };
};

// ---- 목록 후보(기획서 6-1 신호 2) ----
// Task 11에서 결합 로직에 연결한다. 지금은 본문 없이 채널만 남긴다.
function onListCandidate(cand) {
  console.debug('list candidate', cand.channel);
}

// 직렬 큐 안에서 실행된다. 담당 여부와 관계없이 대상 계정의 탭이면 받는다.
handlers.LIST_CANDIDATE = async function (msg) {
  const full = await readFullSettings();
  if (!MBX.assetMatches(full, msg) || !MBX.validCandidateMsg(msg)) return { ok: false, code: 'REJECTED' };
  const at = (typeof msg.at === 'number' && Number.isFinite(msg.at)) ? msg.at : Date.now();
  onListCandidate({ channel: msg.channel, sender: msg.sender, preview: msg.preview, time: msg.time, at: at });
  return { ok: true };
};

// 생존 신호. 감시와 담당 갱신은 Task 12에서 구현한다. 지금은 라우터가 거부하지 않도록 받기만 한다.
handlers.HEARTBEAT = async function (msg) {
  console.debug('heartbeat', !!msg.ok, typeof msg.reason === 'string' ? msg.reason : null);
  return { ok: true };
};

// ---- Slack 전송 대기열(기획서 6-3, 6-4) ----
const ALARM_NAME = 'mbx-tick';
const SLACK_TIMEOUT_MS = 10000;
const NOT_CONFIGURED_MESSAGE = 'Slack 알림이 꺼져 있거나 Webhook 주소가 비어 있습니다. 설정에서 확인하세요';

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

// 호출자가 직렬 큐 안에 있어야 한다(저장소 읽기·쓰기를 가른다). 큐 밖에서는 runSerial(() => enqueue(item))로 부른다.
// 대기열에 넣었으면 true, 설정이 없어 넣지 않았으면 false(lastError 에 기록).
async function enqueue(item) {
  const st = await loadState(['settings', 'slackQueue']);
  const full = Object.assign({}, MBX.DEFAULT_SETTINGS, st.settings);
  if (!full.slackEnabled || !full.slackWebhookUrl) {
    await saveState({ lastError: slackError('NOT_CONFIGURED', NOT_CONFIGURED_MESSAGE) });
    return false;
  }
  const entry = Object.assign({
    id: newItemId(), createdAt: Date.now(), status: 'ready', holdUntil: null, attempts: 0, nextTryAt: 0
  }, item);
  await saveState({ slackQueue: (Array.isArray(st.slackQueue) ? st.slackQueue : []).concat([entry]) });
  return true;
}

// 전송 결과(id -> {outcome, status}). SEND_TEST_SLACK 이 자기 항목의 결과를 읽는 용도이며 캐시일 뿐이다.
const sendResults = new Map();

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

// 1단계(큐 안): 만료 폐기, 중복 폐기, 보낼 항목 선택. 2단계(큐 밖): fetch. 3단계(큐 안): 결과 반영.
async function flushPass(now) {
  const picked = await runSerial(async function () {
    const st = await loadState(['slackQueue', 'sentKeys', 'settings']);
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
    if (out.length && (!full.slackEnabled || !full.slackWebhookUrl)) {
      // 대기 중에 설정이 꺼졌거나 지워졌다. 보낼 곳이 없으므로 해당 항목을 버리고 설정 필요 상태를 남긴다.
      const drop = {};
      out.forEach(function (o) { drop[o.item.id] = true; });
      patch.slackQueue = queue.filter(function (it) { return !drop[it.id]; });
      patch.lastError = slackError('NOT_CONFIGURED', NOT_CONFIGURED_MESSAGE);
      await saveState(patch);
      setActionBadge('!');
      return { list: [], url: '', settings: full };
    }
    patch.slackQueue = queue;
    await saveState(patch);
    return { list: out, url: full.slackWebhookUrl, settings: full };
  });
  if (!picked.list.length) return;

  // 큐 밖: 직렬로 하나씩 보낸다(Slack Webhook 은 초당 1건 안팎이 기준이다).
  const results = [];
  for (const o of picked.list) {
    const r = await postSlack(picked.url, MBX.buildSlackPayload(o.item, picked.settings, now));
    console.debug('slack send', r.status);
    results.push({ id: o.item.id, key: o.key, system: o.item.type === 'system', attempts: o.item.attempts || 0, status: r.status, retryAfterSec: r.retryAfterSec, outcome: MBX.classifyStatus(r.status) });
  }

  await runSerial(async function () {
    const st = await loadState(['slackQueue', 'sentKeys', 'lastError']);
    let queue = Array.isArray(st.slackQueue) ? st.slackQueue : [];
    let sentKeys = Array.isArray(st.sentKeys) ? st.sentKeys : [];
    const patch = {};
    let badge = null;
    let lastError = st.lastError;
    results.forEach(function (r) {
      sendResults.set(r.id, { outcome: r.outcome, status: r.status });
      if (r.outcome === 'ok') {
        queue = queue.filter(function (it) { return it.id !== r.id; });
        if (!r.system) sentKeys = sentKeys.concat([{ key: r.key, at: now }]);
        if (lastError && lastError.source === 'slack') { lastError = null; badge = ''; }
      } else if (r.outcome === 'config') {
        queue = queue.filter(function (it) { return it.id !== r.id; });
        lastError = slackError('CONFIG', '설정 오류(HTTP ' + r.status + '): Webhook 주소를 확인하세요. 재시도하지 않습니다', r.status);
        badge = '!';
      } else {
        queue = queue.map(function (it) {
          return it.id !== r.id ? it : Object.assign({}, it, {
            attempts: r.attempts + 1, nextTryAt: now + MBX.nextRetryDelayMs(r.attempts, r.retryAfterSec)
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

handlers.SEND_TEST_SLACK = async function () {
  const item = {
    id: newItemId(), type: 'system', channel: '', count: 0, kind: 'new', manualHint: false, sender: null, preview: null, time: null,
    text: '[Meta Inbox Helper] 테스트 메시지입니다. 이 메시지가 보이면 Slack 연결이 정상입니다.',
    createdAt: Date.now(), status: 'ready', holdUntil: null, attempts: 0, nextTryAt: 0
  };
  const queued = await runSerial(function () { return enqueue(item); });
  if (!queued) return { ok: false, status: null, code: 'NOT_CONFIGURED', message: NOT_CONFIGURED_MESSAGE };
  await flushQueue(Date.now());
  const r = sendResults.get(item.id);
  sendResults.delete(item.id);
  if (!r) return { ok: false, status: null, code: 'PENDING', message: '전송 결과를 확인하지 못했습니다. 잠시 뒤 다시 확인하세요' };
  if (r.outcome === 'ok') return { ok: true, status: r.status };
  if (r.outcome === 'retry') return { ok: false, status: r.status, code: 'RETRY', message: '전송하지 못했습니다(' + (r.status ? 'HTTP ' + r.status : '네트워크 오류') + '). 자동으로 다시 시도합니다' };
  return { ok: false, status: r.status, code: 'CONFIG', message: '설정 오류(HTTP ' + r.status + '): Webhook 주소를 확인하세요' };
};

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
  flushQueue(Date.now()).catch(function () { console.debug('alarm flush failed'); });
});
ensureAlarm();
flushQueue(Date.now()).catch(function () { console.debug('start flush failed'); });
