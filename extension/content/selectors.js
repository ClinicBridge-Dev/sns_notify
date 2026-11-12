// 모든 DOM 선택자는 이 파일에만 둔다. 요소를 못 찾으면 null(또는 빈 배열)을 돌려주고, 호출한 쪽이 사용자에게 상태를 보여 준다.
// document 는 함수 안에서만 참조한다(node 테스트에서 require 가능).
(function (root) {
  // 문자열 기반(aria-label) 선택자는 배열로 둔다. 화면 언어가 영어가 아니면 값을 추가한다.
  const SUBMIT_LABELS = ['Submit', 'Send']; // U5 미확인: Instagram 화면의 값. 'Send'는 후보, 한국어 값은 확인 후 추가
  const MESSAGE_LIST_LABEL_PREFIXES = ['Message list'];
  const CHANNEL_ICON_ALTS = ['WhatsApp', 'Instagram']; // U1 미확인: Instagram alt 값은 예상
  const SEARCH_SELECTORS = ['input[type="search"]', 'input[placeholder*="Search" i]']; // U11 미확인
  const ICON_ALT_CHANNEL = { WhatsApp: 'wec', Instagram: 'instagram_direct' }; // U1 미확인: Instagram alt 값은 예상
  // 금지 사항 9. 미확인: 실제 로그인·보안 확인·캡차 화면의 주소와 요소. 보수적으로 주소 접두와 비밀번호 입력란, 캡차 iframe 만 본다.
  const BLOCKED_PATH_RE = /^\/(?:login(?:[/.?]|$)|checkpoint(?:\/|$)|two_step_verification(?:\/|$)|two_factor(?:\/|$))/;
  const BLOCKED_SELECTORS = ['input[type="password"]', 'iframe[src*="captcha" i]', 'iframe[title*="captcha" i]'];

  const BASE = 'https://business.facebook.com';

  function parseUrl(s) {
    try { return new URL(s, BASE); } catch (e) { return null; }
  }

  function assetIdFrom(urlString, tabHrefs) {
    const u = parseUrl(urlString);
    const own = u && u.searchParams.get('asset_id');
    if (own) return own;
    const list = Array.isArray(tabHrefs) ? tabHrefs : [];
    for (let i = 0; i < list.length; i++) {
      const t = typeof list[i] === 'string' ? parseUrl(list[i]) : null;
      const v = t && t.searchParams.get('asset_id');
      if (v) return v;
    }
    return null;
  }

  function threadIdFrom(urlString) {
    const u = parseUrl(urlString);
    return (u && u.searchParams.get('selected_item_id')) || null;
  }

  function channelFromPath(pathname) {
    if (typeof pathname !== 'string') return null;
    const m = /^\/latest\/inbox(?:\/([^/?#]*))?(?:\/|$)/.exec(pathname);
    if (!m) return null;
    const seg = m[1] || '';
    if (seg === 'instagram_direct' || seg === 'wec' || seg === 'all') return seg;
    return 'other';
  }

  function parseBadgeText(text) {
    if (typeof text !== 'string') return 0;
    const m = /^\s*(\d+)/.exec(text);
    return m ? parseInt(m[1], 10) : 0;
  }

  function labelMatches(label, labels) {
    if (typeof label !== 'string') return false;
    const l = label.trim().toLowerCase();
    return labels.some(function (x) { return x.toLowerCase() === l; });
  }

  // ---- DOM 조회 ----
  function channelTabs() {
    if (typeof document === 'undefined') return [];
    return Array.from(document.querySelectorAll('[role="tablist"] a'));
  }

  function badgeOf(tabEl) {
    if (!tabEl) return 0;
    const b = tabEl.querySelector('[role="status"]');
    return b ? parseBadgeText(b.textContent) : 0;
  }

  function listContainer() {
    if (typeof document === 'undefined') return null;
    return document.querySelector('[data-pagelet="GenericBizInboxThreadListViewBody"]');
  }

  // 채널 아이콘에서 올라가며 [role="gridcell"]을 포함하는 가장 가까운 조상. 단계 수를 고정하지 않는다.
  function listItems() {
    const c = listContainer();
    if (!c) return [];
    const icons = c.querySelectorAll(CHANNEL_ICON_ALTS.map(function (a) { return 'img[alt="' + a + '"]'; }).join(','));
    const out = [];
    icons.forEach(function (img) {
      let el = img.parentElement;
      while (el && el !== c) {
        if (el.querySelector('[role="gridcell"]')) { if (out.indexOf(el) < 0) out.push(el); return; }
        el = el.parentElement;
      }
    });
    return out;
  }

  // 스크롤 가능한 목록 요소: 목록 컨테이너 또는 가장 가까운 스크롤 조상. 못 찾으면 null.
  function listScroller() {
    const c = listContainer();
    if (!c || typeof getComputedStyle === 'undefined') return null;
    let el = c;
    while (el && el !== document.documentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el;
      el = el.parentElement;
    }
    return null;
  }

  // U12 미확인 (가상화): 대상 요소는 목록 컨테이너 또는 가장 가까운 스크롤 조상으로 가정. 못 찾으면 0.
  function listScrollTop() {
    const el = listScroller();
    return el ? el.scrollTop : 0;
  }

  // 순수 함수: 필터 조건 조각을 안정적인 문자열로 합친다(빈 조각 제거, 정렬).
  function joinFilterState(parts) {
    return (Array.isArray(parts) ? parts : [])
      .filter(function (p) { return typeof p === 'string' && p !== ''; })
      .sort().join('|');
  }

  // U11 미확인: 필터 컨트롤(Unread, Ad replies, Follow up, Filters)이 aria-pressed/selected/checked 로 켜짐을 나타낸다고 가정.
  // 목록 컨테이너 가까운 조상(최대 3단계) 안에서 켜진 컨트롤의 라벨과 검색어를 합친다. 아무것도 없으면 ''.
  function filterState() {
    if (typeof document === 'undefined') return '';
    const parts = [];
    const c = listContainer();
    let scope = c;
    for (let i = 0; scope && scope.parentElement && i < 3; i++) scope = scope.parentElement;
    if (scope) {
      const on = scope.querySelectorAll('[aria-pressed="true"],[aria-selected="true"],[aria-checked="true"]');
      on.forEach(function (el) {
        if (el.closest('[role="tablist"]')) return; // 채널 탭 전환은 필터가 아니다
        if (c && c.contains(el)) return; // 목록 항목 선택 상태 제외
        const label = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40);
        parts.push('on:' + label);
      });
    }
    const q = searchValue();
    if (q) parts.push('q:' + q.trim());
    return joinFilterState(parts);
  }

  // U11 미확인: "읽지 않음으로 표시" 메뉴 위치 미확인이라 목록 영역 클릭과 menu/menuitem 클릭을 모두 사용자 조작으로 본다.
  function isListOrThreadMenu(target) {
    let el = target && target.nodeType === 3 ? target.parentElement : target;
    if (!el || !el.closest) return false;
    if (el.closest('[role="menu"],[role="menuitem"]')) return true;
    const c = listContainer();
    return !!c && c.contains(el);
  }

  function messageRegion() {
    if (typeof document === 'undefined') return null;
    const regions = document.querySelectorAll('[role="region"]');
    for (let i = 0; i < regions.length; i++) {
      if (regions[i].querySelector('[data-message-id]')) return regions[i];
    }
    for (let i = 0; i < regions.length; i++) {
      const l = regions[i].getAttribute('aria-label') || '';
      if (MESSAGE_LIST_LABEL_PREFIXES.some(function (p) { return l.indexOf(p) === 0; })) return regions[i];
    }
    return null;
  }

  function bubbleFrom(target) {
    let el = target && target.nodeType === 3 ? target.parentElement : target;
    if (!el || !el.closest) return null;
    const b = el.closest('[data-message-id]');
    const region = messageRegion();
    return b && region && region.contains(b) ? b : null;
  }

  // 텍스트가 없는 말풍선(사진, 음성, 스티커)은 null.
  function bubbleTextEl(bubbleEl) {
    if (!bubbleEl) return null;
    const els = bubbleEl.querySelectorAll('[dir="auto"]');
    for (let i = 0; i < els.length; i++) {
      if ((els[i].innerText || els[i].textContent || '').trim()) return els[i];
    }
    return null;
  }

  function composer() {
    if (typeof document === 'undefined') return null;
    return document.querySelector('div[role="textbox"][contenteditable="true"][data-lexical-editor="true"]');
  }

  function buttonLabelMatches(btn) {
    return labelMatches(btn.getAttribute('aria-label'), SUBMIT_LABELS);
  }

  // 입력창에서 위로 올라가며 전송 버튼이 있는 가장 가까운 조상 안에서만 찾는다.
  function submitButton() {
    const c = composer();
    let el = c && c.parentElement;
    for (let depth = 0; el && depth < 10; depth++, el = el.parentElement) {
      const btns = el.querySelectorAll('div[role="button"][aria-label]');
      for (let i = 0; i < btns.length; i++) if (buttonLabelMatches(btns[i])) return btns[i];
    }
    return null;
  }

  function isSubmitButton(target) {
    let el = target && target.nodeType === 3 ? target.parentElement : target;
    if (!el || !el.closest) return false;
    const btn = el.closest('div[role="button"]');
    if (!btn || !buttonLabelMatches(btn)) return false;
    const s = submitButton();
    return !!s && s === btn;
  }

  // Meta의 대화상자가 열려 있는지. 입력창을 포함하는 role="dialog"는 세지 않는다.
  function dialogOpen() {
    if (typeof document === 'undefined') return false;
    const c = composer();
    const ds = document.querySelectorAll('[role="dialog"]');
    for (let i = 0; i < ds.length; i++) {
      if (c && ds[i].contains(c)) continue;
      if (ds[i].getClientRects().length > 0) return true;
    }
    return false;
  }

  function searchValue() {
    if (typeof document === 'undefined') return null;
    for (let i = 0; i < SEARCH_SELECTORS.length; i++) {
      const el = document.querySelector(SEARCH_SELECTORS[i]);
      if (el) return typeof el.value === 'string' ? el.value : '';
    }
    return null;
  }

  // ---- 감지(watcher)용 ----
  function channelOfIconAlt(alt) {
    return Object.prototype.hasOwnProperty.call(ICON_ALT_CHANNEL, alt) ? ICON_ALT_CHANNEL[alt] : null;
  }

  function channelOfHref(href) {
    if (typeof href !== 'string' || !href) return null;
    const u = parseUrl(href);
    return u ? channelFromPath(u.pathname) : null;
  }

  // 채널 탭 영역(관찰 대상). 못 찾으면 null.
  function channelTabArea() {
    const tabs = channelTabs();
    return tabs.length ? tabs[0].closest('[role="tablist"]') : null;
  }

  // 두 채널 배지 값. 두 탭 모두 못 찾으면 null(0으로 읽어 기준값을 내리지 않게 한다). 한쪽만 있으면 다른 쪽은 0.
  function channelBadges() {
    const out = { instagram_direct: 0, wec: 0 };
    let found = 0;
    channelTabs().forEach(function (a) {
      const c = channelOfHref(a.getAttribute('href'));
      if (c === 'instagram_direct' || c === 'wec') { out[c] = badgeOf(a); found++; }
    });
    return found ? out : null;
  }

  // 목록 항목의 요약 줄. 호출한 쪽은 로그에 남기지 않는다.
  function itemLines(itemEl) {
    if (!itemEl) return [];
    const t = itemEl.innerText || itemEl.textContent || '';
    return t.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l !== ''; });
  }

  function itemChannel(itemEl) {
    if (!itemEl) return null;
    const imgs = itemEl.querySelectorAll('img[alt]');
    for (let i = 0; i < imgs.length; i++) {
      const c = channelOfIconAlt(imgs[i].getAttribute('alt'));
      if (c) return c;
    }
    return null;
  }

  function isBlockedPath(pathname) {
    return typeof pathname === 'string' && BLOCKED_PATH_RE.test(pathname);
  }

  // 로그인·보안 확인·캡차 화면이면 'login', 아니면 null.
  function blockedScreen() {
    if (typeof document === 'undefined' || typeof location === 'undefined') return null;
    if (isBlockedPath(location.pathname)) return 'login';
    for (let i = 0; i < BLOCKED_SELECTORS.length; i++) {
      if (document.querySelector(BLOCKED_SELECTORS[i])) return 'login';
    }
    return null;
  }

  root.sel = {
    assetIdFrom, threadIdFrom, channelFromPath, parseBadgeText, labelMatches,
    channelTabs, badgeOf, listContainer, listItems, listScrollTop, filterState, joinFilterState, isListOrThreadMenu, messageRegion,
    bubbleFrom, bubbleTextEl, composer, submitButton, isSubmitButton, searchValue, dialogOpen,
    channelOfIconAlt, channelOfHref, channelTabArea, channelBadges, itemLines, itemChannel, isBlockedPath, blockedScreen
  };
})(typeof module !== 'undefined' && module.exports ? module.exports : (self.MBX = self.MBX || {}));
