importScripts('lib/constants.js', 'lib/settings.js', 'lib/serial.js');

const MBX = self.MBX;
const runSerial = MBX.createSerialQueue();

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

handlers.OPEN_OPTIONS = async function () {
  chrome.runtime.openOptionsPage();
};

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  const kind = MBX.classifySender(sender, chrome.runtime.id);
  const type = msg && msg.type;
  if (kind === 'reject' || typeof type !== 'string' || !MBX.isAllowed(type, kind) ||
      !Object.prototype.hasOwnProperty.call(handlers, type)) {
    sendResponse({ ok: false, code: 'REJECTED' });
    return false;
  }
  runSerial(function () { return handlers[type](msg, sender); })
    .then(function (res) { sendResponse(res); })
    .catch(function () {
      console.debug('handler failed', type);
      sendResponse({ ok: false, code: 'INTERNAL' });
    });
  return true;
});
