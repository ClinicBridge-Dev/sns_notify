// 모든 DOM 선택자는 이 파일에만 둔다. 요소를 못 찾으면 null(또는 빈 배열)을 돌려주고, 호출한 쪽이 사용자에게 상태를 보여 준다.
// document 는 함수 안에서만 참조한다(node 테스트에서 require 가능).
(function (root) {
  // 문자열 기반(aria-label) 선택자는 배열로 둔다. 화면 언어가 영어가 아니면 값을 추가한다.
  const SUBMIT_LABELS = ['Submit', 'Send']; // U5 미확인: Instagram 화면의 값. 'Send'는 후보, 한국어 값은 확인 후 추가
  const MESSAGE_LIST_LABEL_PREFIXES = ['Message list'];
  const CHANNEL_ICON_ALTS = ['WhatsApp', 'Instagram']; // U1 미확인: Instagram alt 값은 예상
  const SEARCH_SELECTORS = ['input[type="search"]', 'input[placeholder*="Search" i]']; // U11 미확인

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

  function listScrollTop() {
    const c = listContainer();
    if (!c || typeof getComputedStyle === 'undefined') return null;
    let el = c;
    while (el && el !== document.documentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el.scrollTop;
      el = el.parentElement;
    }
    return 0;
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

  root.sel = {
    assetIdFrom, threadIdFrom, channelFromPath, parseBadgeText, labelMatches,
    channelTabs, badgeOf, listContainer, listItems, listScrollTop, messageRegion,
    bubbleFrom, bubbleTextEl, composer, submitButton, isSubmitButton, searchValue, dialogOpen
  };
})(typeof module !== 'undefined' && module.exports ? module.exports : (self.MBX = self.MBX || {}));
