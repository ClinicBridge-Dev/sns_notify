// R1 관찰과 보고(기획서 6-1, 6-5). 본 것을 그대로 service worker에 보낸다. 새 메시지 여부의 최종 판단은 service worker가 한다.
// fetch와 chrome.storage는 쓰지 않는다. 목록을 스크롤하거나 클릭하지 않는다(금지 사항 3).
// 로그는 console.debug만, 이름·미리보기 같은 본문은 넣지 않는다.
(function (root) {
  const sel = root.sel;
  const util = root.util;
  const L = root; // lib/listcand.js, lib/constants.js 가 MBX에 붙인 함수와 상수

  const POLL_MS = 60000;          // 관찰자가 끊겼을 때 대비한 보조 조회
  const FAIL_AFTER_MS = 60000;    // 로그인 화면·선택자 실패·asset_id 없음이 이만큼 이어지면 알린다
  const USER_ACTION_MS = 2000;    // userActionRecent 범위
  const ATTACH_DELAY_MS = 200;
  const SCROLL_DELAY_MS = 150;   // 스크롤·입력·클릭 모음
  const NOTICE_OTHER = '알림 대상 계정이 아닙니다';
  const NOTICE_UNSET = '설정에서 알림 대상 계정을 지정하세요';
  const NOTICE_SELECTOR = '수신함 화면 요소를 찾지 못해 Slack 알림 감지가 멈췄습니다';
  const NOTICE_NO_ASSET = '계정 정보(asset_id)를 읽지 못해 Slack 알림 감지가 멈췄습니다';
  const NOTICE_BLOCKED = '로그인/보안 확인 화면에서 감지를 멈췄습니다';
  const BLOCK_GRACE_MS = 3000;    // 로그인·보안 확인 표시가 이만큼 이어져야 차단으로 본다(잠깐의 오인 방지)
  const CONFIRM_DELAY_MS = 400;   // 가려진 탭의 두 번째 관찰(HOLD_MS 안)
  const LIST_PATHS = ['wec', 'instagram_direct', 'all']; // 신호 2를 수행하는 경로(댓글 등 제외)

  let started = false;
  let settle = null;              // { phase: 'load'|'change'|'ready', lastChange }
  const known = new Set();        // 알고 있는 항목 키(메모리에만, 최대 KNOWN_CAP)
  let stableKeys = [];            // 안정화 중 마지막으로 본 위쪽 항목 키. 안정화가 끝날 때 기억한다
  let lastSig = null;             // 배지 + 위쪽 항목 키
  let lastBadgeKey = null;        // 마지막으로 보낸 배지 값
  let initialPending = true;      // 'load' 안정화 뒤 첫 배지 보고에 initial 표시
  let account = 'unknown';        // 'match' | 'other' | 'unset' | 'none' | 'unknown'
  let screenKey = null;           // 경로 + filterState()(검색어 포함)
  let wasScrolledDown = false;
  let blocked = false;
  let lastUserActionAt = 0;
  let listDirty = false;          // 'ready'에서 목록이 바뀌어 판단할 것이 있다
  let debounceDue = false;
  let confirmDue = false;
  let prevCandKeys = null;        // 가려진 탭: 직전 관찰의 후보 키
  let debounceTimer = null, confirmTimer = null, settleTimer = null, failTimer = null;
  let attachTimer = null, scrollTimer = null; // scrollTimer: scheduleObserve 의 모음 타이머
  let failSince = 0, failReported = false;
  let blockSeenSince = 0, blockTimer = null;
  let observedTabs = null, observedList = null;
  let mo = null;
  let notice = null;

  function isOwner() { return util.role() === 'owner'; }
  function inInbox() { return sel.channelFromPath(location.pathname) !== null; }
  function visible() { return document.visibilityState === 'visible'; }

  function tabHrefs() {
    return sel.channelTabs().map(function (a) { return a.getAttribute('href') || ''; });
  }

  // 보고를 만들 때마다 주소(없으면 탭 링크)에서 직접 읽는다.
  function currentAssetId() { return sel.assetIdFrom(location.href, tabHrefs()); }

  function targetAssetId() {
    const s = util.settings();
    if (!s) return null;
    return typeof s.assetId === 'string' ? s.assetId.trim() : '';
  }

  function accountState() {
    const target = targetAssetId();
    if (target === null) return 'unknown';
    if (!target) return 'unset';
    const id = currentAssetId();
    if (!id) return 'none';
    return id === target ? 'match' : 'other';
  }

  // ---- 안내 표시(Shadow DOM, mbx- 접두) ----
  function buildNotice() {
    const h = util.host();
    const style = document.createElement('style');
    style.textContent =
      '.mbx-wnotice{position:fixed;left:16px;bottom:16px;z-index:1;display:none;align-items:center;gap:8px;' +
      'max-width:320px;padding:6px 10px;border:1px solid #e0c36a;border-radius:6px;background:#fff8dc;color:#333;' +
      'font:12px/1.4 system-ui,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.15)}' +
      '.mbx-wnotice button{font:inherit;padding:2px 8px;border:1px solid #bbb;border-radius:4px;background:#fff;color:#222;cursor:pointer}';
    h.appendChild(style);
    const box = document.createElement('div');
    box.className = 'mbx-wnotice';
    const text = document.createElement('span');
    text.className = 'mbx-wnotice-text';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mbx-wnotice-open';
    btn.textContent = '설정 열기';
    btn.addEventListener('click', function () { util.send('OPEN_OPTIONS'); });
    box.appendChild(text);
    box.appendChild(btn);
    h.appendChild(box);
    return { box: box, text: text, btn: btn };
  }

  const NOTICE_TEXT = { other: NOTICE_OTHER, unset: NOTICE_UNSET, selector: NOTICE_SELECTOR, no_asset_id: NOTICE_NO_ASSET, blocked: NOTICE_BLOCKED };

  // Meta의 대화상자가 열려 있으면 숨긴다(기획서 12장).
  function showNotice(kind) {
    if (!kind || sel.dialogOpen()) { if (notice) notice.box.style.display = 'none'; return; }
    if (!notice) notice = buildNotice();
    notice.text.textContent = NOTICE_TEXT[kind] || '';
    notice.btn.style.display = kind === 'unset' ? '' : 'none';
    notice.box.style.display = 'flex';
  }

  // ---- 안정화 ----
  function settleWait() { return settle.phase === 'load' ? L.SETTLE_LOAD_MS : L.SETTLE_CHANGE_MS; }

  // 가려진 탭에서는 타이머가 늦으므로 관찰자 콜백마다 settleTick 으로도 확인한다. 이 타이머는 보조다.
  function scheduleSettle() {
    clearTimeout(settleTimer);
    settleTimer = null;
    if (settle.phase === 'ready') return;
    const wait = Math.max(0, settleWait() - (Date.now() - settle.lastChange)) + 50;
    settleTimer = setTimeout(function () { settleTimer = null; observe(); }, wait);
  }

  function clearListWork() {
    clearTimeout(debounceTimer); debounceTimer = null;
    clearTimeout(confirmTimer); confirmTimer = null;
    listDirty = false; debounceDue = false; confirmDue = false; prevCandKeys = null;
  }

  function enterSettle(kind, now) {
    settle = L.settleEnter(settle, kind, now);
    if (settle.phase === 'load') initialPending = true;
    clearListWork();
    scheduleSettle();
    console.debug('watcher settle', settle.phase);
  }

  // ---- 읽기 ----
  function toItem(el, pathCh) {
    const p = L.parseItemLines(sel.itemLines(el));
    if (!p) return null;
    // 채널은 아이콘으로만 정한다. 채널 경로에서는 경로의 채널과 같아야 한다(다른 채널·댓글 항목 제외).
    const ch = sel.itemChannel(el);
    if (!ch) return null;
    if (pathCh !== 'all' && ch !== pathCh) return null;
    const it = { channel: ch, name: p.name, preview: p.preview, time: p.time };
    it.key = L.itemKey(it);
    return it;
  }

  function readTopItems() {
    const pathCh = sel.channelFromPath(location.pathname);
    const els = sel.listItems();
    const out = [];
    for (let i = 0; i < els.length && out.length < L.LIST_TOP_N; i++) {
      const it = toItem(els[i], pathCh);
      if (it) out.push(it);
    }
    return out;
  }

  // 목록이 내려가 있을 때: 화면에 보이는 항목만 읽어 기억한다.
  function readVisibleKeys() {
    const pathCh = sel.channelFromPath(location.pathname);
    const h = window.innerHeight || 0;
    const keys = [];
    sel.listItems().forEach(function (el) {
      const r = el.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= h) return;
      const it = toItem(el, pathCh);
      if (it) keys.push(it.key);
    });
    return keys;
  }

  function listPath() { return LIST_PATHS.indexOf(sel.channelFromPath(location.pathname)) >= 0; }

  function keysOf(items) { return items.map(function (i) { return i.key; }); }

  // ---- 상태 점검(생존 신호) ----
  function health() {
    if (blocked || sel.blockedScreen()) return { ok: false, reason: 'login' };
    if (!inInbox()) return { ok: false, reason: null };
    const acc = accountState();
    if (acc === 'none') return { ok: false, reason: 'no_asset_id' };
    if (acc !== 'match') return { ok: false, reason: null }; // 미설정·다른 계정·설정 수신 전: 보고하지 않는다
    if (!sel.channelTabs().length || !sel.listContainer()) return { ok: false, reason: 'selector' };
    return { ok: true, reason: null };
  }

  // 실패 시간은 마지막으로 완전히 정상이었던 관찰부터 센다. 실패 사유가 잠깐 바뀌어도(깜빡임) 다시 세지 않는다.
  // 보고 대상이 아닌 상태(미설정·다른 계정·수신함 밖)는 실패가 아니므로 시계를 멈추지도 시작하지도 않는다.
  function updateHealth(now) {
    const h = health();
    if (h.ok) {
      failSince = 0; failReported = false;
      clearTimeout(failTimer); failTimer = null;
    } else if (h.reason && !failSince) {
      failSince = now;
      clearTimeout(failTimer);
      failTimer = setTimeout(checkFailure, FAIL_AFTER_MS + 50);
    }
    return h;
  }

  function failingLongEnough(now) { return failSince > 0 && now - failSince >= FAIL_AFTER_MS; }

  // 실패가 60초를 넘은 순간 즉시 알린다(이후는 30초 생존 신호에 실린다).
  function checkFailure() {
    failTimer = null;
    observe(); // 화면 안내 갱신
    if (failingLongEnough(Date.now()) && !failReported) heartbeat();
  }

  function heartbeat() {
    try { heartbeatOnce(); } catch (e) { console.debug('watcher heartbeat error'); }
  }

  // 정상 신호(ok: true)는 담당 탭만 보낸다. 실패 신호(원인 있음, 60초 이상)는 담당 여부와 관계없이 보낸다:
  // asset_id를 못 읽은 탭은 담당이 될 수 없으므로, 담당만 보내게 하면 그 원인을 알릴 길이 없다.
  // service worker는 담당이 보냈거나 담당이 없을 때만 실패 경고를 낸다(정상인 담당이 있으면 무시).
  function heartbeatOnce() {
    if (!started) return;
    const now = Date.now();
    const h = updateHealth(now);
    if (h.ok && !isOwner()) return;
    if (!h.ok && (!h.reason || !failingLongEnough(now))) return;
    const msg = { asset_id: currentAssetId() || '', ok: h.ok, reason: h.reason, path: location.pathname };
    if (h.ok && settle.phase !== 'load') {
      const badges = sel.channelBadges();
      if (badges) msg.badges = badges;
    }
    if (!h.ok) failReported = true;
    util.send('HEARTBEAT', msg);
  }

  // ---- 보고 ----
  function sendBadges(badges, now) {
    const id = currentAssetId();
    if (!id || id !== targetAssetId()) return;
    util.send('BADGE_STATE', {
      asset_id: id,
      badges: { instagram_direct: badges.instagram_direct, wec: badges.wec },
      initial: initialPending,
      userActionRecent: now - lastUserActionAt <= USER_ACTION_MS,
      at: now
    });
    initialPending = false;
    lastBadgeKey = badges.instagram_direct + ',' + badges.wec;
  }

  function sendCandidates(cands, now) {
    if (!cands.length) return;
    const id = currentAssetId();
    if (!id || id !== targetAssetId()) return;
    cands.forEach(function (c) {
      util.send('LIST_CANDIDATE', { asset_id: id, channel: c.channel, sender: c.name, preview: c.preview, time: c.time, at: now });
      console.debug('list candidate sent', c.channel);
    });
  }

  function scheduleDebounce() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () { debounceTimer = null; debounceDue = true; observe(); }, L.LIST_DEBOUNCE_MS);
  }

  // 가려진 탭: 마지막 변화 뒤에는 관찰자가 다시 불리지 않으므로 두 번째 관찰을 한 번 예약한다.
  function scheduleConfirm() {
    if (confirmTimer) return;
    confirmTimer = setTimeout(function () { confirmTimer = null; confirmDue = true; observe(); }, CONFIRM_DELAY_MS);
  }

  function evaluate(items, now) {
    const r = L.findCandidates(items, known);
    if (r.reset) {
      console.debug('watcher list reset');
      enterSettle('change', now);
      stableKeys = keysOf(items);
      return;
    }
    let toSend = r.candidates;
    let hold = [];
    if (!visible() && L.HIDDEN_TAB_DOUBLE_OBSERVE) {
      const c = L.confirmTwice(prevCandKeys, r.candidates);
      toSend = c.confirmed; hold = c.unconfirmed; prevCandKeys = c.next;
      if (hold.length) scheduleConfirm();
    } else {
      prevCandKeys = null;
    }
    sendCandidates(toSend, now);
    // 확정되지 않은 후보는 기억하지 않는다(다음 관찰에서 다시 후보가 되도록).
    const holdKeys = new Set(keysOf(hold));
    L.remember(known, keysOf(items).filter(function (k) { return !holdKeys.has(k); }), L.KNOWN_CAP);
  }

  // ---- 관찰 한 번 ----
  // 한 기능의 오류가 다른 기능을 멈추지 않게 분리한다(기획서 12장).
  function observe() {
    try { observeOnce(); } catch (e) { console.debug('watcher observe error'); }
  }

  function observeOnce() {
    if (!started) return;
    const now = Date.now();
    attach();

    // 금지 사항 9: 로그인·보안 확인·캡차 화면에서는 모든 기능을 멈춘다(안내 표시와 생존 신호의 실패 보고만 예외).
    // 표시가 BLOCK_GRACE_MS 넘게 이어져야 차단으로 본다. 그 전에도 판단과 보고는 쉬어 간다.
    const raw = !!sel.blockedScreen();
    if (raw) {
      if (!blockSeenSince) {
        blockSeenSince = now;
        clearTimeout(blockTimer);
        blockTimer = setTimeout(function () { blockTimer = null; observe(); }, BLOCK_GRACE_MS + 50);
      }
      if (!blocked && now - blockSeenSince >= BLOCK_GRACE_MS) { blocked = true; clearListWork(); console.debug('watcher blocked'); }
    } else {
      blockSeenSince = 0;
      clearTimeout(blockTimer); blockTimer = null;
    }
    if (blocked && !raw) { blocked = false; enterSettle('load', now); } // 로그인 복귀
    updateHealth(now);
    if (blocked) { showNotice('blocked'); return; }
    if (raw) return; // 유예 중: 쉬어 간다(안내·load 재진입 없음)
    const h = health();

    if (!inInbox()) { showNotice(null); account = 'unknown'; clearListWork(); return; }

    const acc = accountState();
    // 요소를 못 찾은 상태가 60초 넘게 이어지면 화면에도 알린다(담당 여부와 관계없이).
    const longFail = failingLongEnough(now) && (h.reason === 'selector' || h.reason === 'no_asset_id') ? h.reason : null;
    showNotice(acc === 'other' || acc === 'unset' ? acc : longFail);
    if (acc !== 'match') {
      if (account === 'match') clearListWork();
      account = acc;
      return;
    }
    if (account !== 'match') { account = 'match'; enterSettle('load', now); } // 페이지 로드·대상 계정 화면 복귀

    // 화면 조건 변경: 경로 + filterState()(검색어 포함)
    const sk = location.pathname + '|' + sel.filterState();
    if (screenKey !== null && sk !== screenKey) enterSettle('change', now);
    screenKey = sk;

    // 맨 위로 돌아온 순간은 화면 조건 변경으로 취급한다.
    const scrolledDown = sel.listScrollTop() > 0;
    if (!scrolledDown && wasScrolledDown) enterSettle('change', now);
    wasScrolledDown = scrolledDown;

    const badges = sel.channelBadges(); // 탭을 못 찾으면 null(0으로 보내지 않는다)
    const onListPath = listPath();
    const items = (scrolledDown || !onListPath) ? [] : readTopItems();

    // 조용한 시간이 지났으면 먼저 'ready'로 바꾸고, 그때까지 안정된 목록을 기억한다.
    const t = L.settleTick(settle, now);
    if (t.becameReady) {
      settle = t.state;
      L.remember(known, stableKeys, L.KNOWN_CAP);
      stableKeys = [];
      clearTimeout(settleTimer); settleTimer = null;
      console.debug('watcher ready', t.from);
    }

    const sig = JSON.stringify([badges, keysOf(items)]);
    const changed = sig !== lastSig;
    lastSig = sig;
    if (settle.phase !== 'ready') {
      if (changed) { settle = L.settleTouch(settle, now); scheduleSettle(); }
      stableKeys = keysOf(items);
    } else if (changed) {
      listDirty = true;
    }

    // 신호 1: 배지. 담당일 때만, 'load' 안정화 중에는 보내지 않는다.
    if (badges && settle.phase !== 'load' && isOwner()) {
      const bk = badges.instagram_direct + ',' + badges.wec;
      if (bk !== lastBadgeKey || initialPending) sendBadges(badges, now);
    }

    // 신호 2: 목록. 담당 여부와 관계없이 수행한다. 메시지 채널 경로(wec, instagram_direct, all)에서만.
    if (!onListPath) { clearListWork(); return; }
    if (scrolledDown) {
      L.remember(known, readVisibleKeys(), L.KNOWN_CAP);
      listDirty = false;
      return;
    }
    if (settle.phase !== 'ready') return;
    if (!listDirty && !confirmDue) { debounceDue = false; return; }
    if (visible()) {
      if (changed || !debounceTimer) { if (!debounceDue) scheduleDebounce(); }
      if (!debounceDue) return;
    }
    // 가려진 탭에서 바로 판단하면 남아 있던 디바운스 타이머를 지운다(나중에 울려 다음 판단을 앞당기지 않게).
    clearTimeout(debounceTimer); debounceTimer = null;
    debounceDue = false; confirmDue = false; listDirty = false;
    evaluate(items, now);
  }

  // ---- 관찰자 연결 ----
  // Meta가 탭 영역이나 목록 컨테이너를 새로 그리면 다시 붙인다.
  function attach() {
    const t = sel.channelTabArea();
    const l = sel.listContainer();
    if (t === observedTabs && l === observedList) return;
    mo.disconnect();
    observedTabs = t; observedList = l;
    const opts = { childList: true, subtree: true, characterData: true };
    if (t) mo.observe(t, opts);
    if (l) mo.observe(l, opts);
  }

  function scheduleAttach() {
    if (attachTimer) return;
    attachTimer = setTimeout(function () { attachTimer = null; observe(); }, ATTACH_DELAY_MS);
  }

  // 스크롤·입력·클릭은 자주 일어나므로 모아서 한 번 관찰한다.
  function scheduleObserve() {
    if (scrollTimer) return;
    scrollTimer = setTimeout(function () { scrollTimer = null; observe(); }, SCROLL_DELAY_MS);
  }

  // 기획서 6-1: 필터 상태를 판별할 수 없을 수 있으므로(U11) 목록 위쪽 필터·검색 영역 조작도 화면 조건 변경으로 본다.
  function headerTouched(target) {
    try {
      if (!started || blocked || account !== 'match' || !sel.isListHeaderControl(target)) return;
      enterSettle('change', Date.now());
    } catch (e) { console.debug('watcher header check error'); }
  }

  function init() {
    if (started) return;
    started = true;
    settle = L.settleStart(Date.now());
    mo = new MutationObserver(function () { observe(); });
    new MutationObserver(function () {
      if (!observedTabs || !observedList || !observedTabs.isConnected || !observedList.isConnected) scheduleAttach();
    }).observe(document.documentElement, { childList: true, subtree: true });

    document.addEventListener('click', function (e) {
      if (sel.isListOrThreadMenu(e.target)) lastUserActionAt = Date.now();
      headerTouched(e.target);
      scheduleObserve(); // 필터 클릭 등 화면 조건 변경 확인
    }, true);
    document.addEventListener('scroll', scheduleObserve, { capture: true, passive: true });
    document.addEventListener('input', function (e) { headerTouched(e.target); scheduleObserve(); }, true); // 검색어 변경 확인
    document.addEventListener('visibilitychange', function () { prevCandKeys = null; observe(); });

    util.onInboxChange(function () { observe(); });
    util.onMessage('SETTINGS_CHANGED', function () { observe(); });
    util.onMessage('WATCHER_ROLE', function () {
      lastBadgeKey = null; // 담당이 되면 현재 값을 바로 보낸다
      // 이미 안정화된 대기 탭이 담당을 이어받으면 첫 보고는 저장된 기준값과의 일반 비교다(기획서 6-1).
      // initial 로 보내면 'away' 로 분류돼 목록 후보와 합쳐지지 않고 알림이 두 번 간다.
      if (settle && settle.phase !== 'load') initialPending = false;
      observe();
      heartbeat();
    });

    setInterval(observe, POLL_MS);
    setInterval(heartbeat, L.HEARTBEAT_MS);
    observe();
  }

  if (typeof document !== 'undefined' && sel && util) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }
})(self.MBX = self.MBX || {});
