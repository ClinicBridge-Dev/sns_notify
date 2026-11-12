// content script 공용: service worker 연결(port), Shadow DOM 호스트, 토스트, 주소 변화 감지.
// fetch와 chrome.storage는 쓰지 않는다. 로그는 console.debug만, 본문은 넣지 않는다.
(function (root) {
  const sel = root.sel;
  const RELOAD_NOTICE = '확장 프로그램이 갱신되었습니다. 페이지를 새로고침하세요';
  const handlers = {}; // type -> [fn]
  let port = null;
  let settings = null;
  let role = null;
  let noticeShown = false;
  let helloKey = null;
  let hostRoot = null;
  let toastTimer = null;

  function alive() {
    try { return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  // ---- Shadow DOM 호스트 ----
  // document_start 에서는 body가 없으므로 요소를 먼저 만들어 두고 body가 생기면 붙인다.
  function host() {
    if (hostRoot) return hostRoot;
    const el = document.createElement('mbx-root');
    el.id = 'mbx-root';
    hostRoot = el.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent =
      '.mbx-toast{position:fixed;right:16px;bottom:16px;max-width:320px;padding:10px 14px;border-radius:8px;' +
      'background:#222;color:#fff;font:13px/1.4 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);' +
      'white-space:pre-wrap;pointer-events:none}';
    hostRoot.appendChild(style);
    const attach = function () {
      if (el.isConnected) return true;
      if (!document.body) return false;
      document.body.appendChild(el);
      return true;
    };
    if (!attach()) {
      const mo = new MutationObserver(function () { if (attach()) mo.disconnect(); });
      mo.observe(document.documentElement, { childList: true });
      document.addEventListener('DOMContentLoaded', attach, { once: true });
    }
    return hostRoot;
  }

  function toast(text) {
    try {
      const h = host();
      let t = h.querySelector('.mbx-toast');
      if (!t) { t = document.createElement('div'); t.className = 'mbx-toast'; h.appendChild(t); }
      t.textContent = String(text);
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 6000);
    } catch (e) { console.debug('toast failed'); }
  }

  function noticeOnce() {
    if (noticeShown) return;
    noticeShown = true;
    toast(RELOAD_NOTICE);
  }

  // ---- 연결 ----
  function dispatch(type, msg) {
    (handlers[type] || []).forEach(function (fn) {
      try { fn(msg); } catch (e) { console.debug('handler error', type); }
    });
  }

  function onPortMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'HELLO_REPLY') {
      settings = msg.settings || null;
      role = msg.role || null;
      dispatch('SETTINGS_CHANGED', { type: 'SETTINGS_CHANGED', settings: settings, quickRepliesChanged: false });
      dispatch('WATCHER_ROLE', { type: 'WATCHER_ROLE', role: role });
      return;
    }
    if (msg.type === 'SETTINGS_CHANGED' && msg.settings) settings = msg.settings;
    if (msg.type === 'WATCHER_ROLE') role = msg.role || role;
    dispatch(msg.type, msg);
  }

  function connect() {
    if (port) return;
    if (!alive()) { noticeOnce(); return; }
    try {
      port = chrome.runtime.connect({ name: 'mbx-content' });
    } catch (e) { port = null; noticeOnce(); return; }
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(function () {
      port = null;
      helloKey = null;
      void (chrome.runtime && chrome.runtime.lastError);
      // service worker 재시작이면 다시 연결한다. 확장이 갱신된 경우(chrome.runtime.id 없음)는 안내한다.
      if (!alive()) { noticeOnce(); return; }
      setTimeout(function () { sendHello(); }, 1000);
    });
  }

  function currentInfo() {
    const tabHrefs = sel.channelTabs().map(function (a) { return a.getAttribute('href') || ''; });
    return {
      asset_id: sel.assetIdFrom(location.href, tabHrefs) || '',
      path: location.pathname
    };
  }

  // 수신함 경로에서만 연결한다. 같은 (asset_id, path)로는 다시 보내지 않는다.
  function sendHello() {
    if (sel.channelFromPath(location.pathname) === null) return;
    connect();
    if (!port) return;
    const info = currentInfo();
    const key = info.asset_id + '|' + info.path;
    if (key === helloKey) return;
    try {
      port.postMessage({ type: 'HELLO', asset_id: info.asset_id, path: info.path });
      helloKey = key;
    } catch (e) { port = null; helloKey = null; console.debug('hello failed'); }
  }

  function send(type, payload) {
    return new Promise(function (resolve) {
      const disconnected = function () { noticeOnce(); resolve({ ok: false, code: 'DISCONNECTED' }); };
      if (!alive()) { disconnected(); return; }
      try {
        const msg = Object.assign({}, payload || {}, { type: type });
        chrome.runtime.sendMessage(msg, function (res) {
          if (chrome.runtime.lastError || res === undefined) { disconnected(); return; }
          resolve(res);
        });
      } catch (e) { disconnected(); }
    });
  }

  function onMessage(type, fn) {
    (handlers[type] = handlers[type] || []).push(fn);
  }

  // ---- 주소 변화 ----
  function onInboxChange(fn) {
    const keyOf = function () {
      return location.pathname + '|' + sel.assetIdFrom(location.href, []) + '|' + sel.threadIdFrom(location.href);
    };
    let last = keyOf();
    const check = function () {
      const k = keyOf();
      if (k === last) return;
      last = k;
      try { fn({ path: location.pathname, assetId: sel.assetIdFrom(location.href, []), threadId: sel.threadIdFrom(location.href) }); }
      catch (e) { console.debug('onInboxChange handler error'); }
    };
    // 경로나 쿼리를 건드리지 않고 관찰만 한다(history API를 감싸지 않는다).
    new MutationObserver(check).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(check, 1000);
  }

  function init() {
    host();
    sendHello();
    onInboxChange(function () { sendHello(); });
    // 탭 링크의 asset_id는 DOM이 그려진 뒤에야 읽히므로 한 번 더 시도한다.
    setInterval(sendHello, 5000);
  }

  root.util = {
    send, connected: function () { return !!port; }, onMessage,
    settings: function () { return settings; },
    role: function () { return role; },
    host, toast, onInboxChange
  };

  if (typeof document !== 'undefined' && root.sel) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }
})(self.MBX = self.MBX || {});
