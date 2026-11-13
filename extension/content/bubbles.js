// R2~R4: 말풍선 아래 액션 줄(번역 보기, 원문 복사, 번역 복사)과 번역 상자(UI 수정 기획서 3장).
// 텍스트 말풍선마다 [data-mbx="actions"] 요소 1개를 말풍선의 다음 형제로 넣는다. 안쪽은 Shadow DOM 이다.
// 넣을 말풍선은 구조(내용 있는 텍스트 노드의 존재)만 보고 고른다. 본문은 그 말풍선의 버튼을 눌렀을 때만 읽는다(금지 사항 5).
// 로그인·보안 확인·캡차 화면에서는 넣은 요소를 모두 지우고 새로 넣지 않는다(금지 사항 9, 2장 11번).
// fetch와 chrome.storage는 쓰지 않는다. 로그는 console.debug만, 본문은 넣지 않는다.
(function (root) {
  const sel = root.sel;
  const util = root.util;
  const COPIED_MS = 1500;
  const RESCAN_MS = 2000;
  const NOTICE_NO_ROWS = '말풍선 버튼을 표시하지 못했습니다';

  const CSS =
    ':host{all:initial;display:block;margin-top:4px;max-width:100%;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;' +
    'color:#1C1E21;cursor:default}' +
    '.mbx-wrap{display:flex;flex-direction:column;align-items:flex-start}' +
    ':host([data-side="out"]) .mbx-wrap{align-items:flex-end}' +
    '.mbx-row{display:flex;align-items:center;gap:6px;height:24px;flex-wrap:nowrap;white-space:nowrap}' +
    '.mbx-pill{font:inherit;font-size:12px;font-weight:500;line-height:24px;height:24px;padding:0 10px;border:0;border-radius:999px;' +
    'background:#E4E6EB;color:#1C1E21;cursor:pointer;white-space:nowrap;margin:0;transition:background-color .12s ease-out}' +
    '.mbx-pill:hover{background:#D8DADF}.mbx-pill:active{background:#CED0D4}' +
    '.mbx-pill:focus{outline:none}.mbx-pill:focus-visible{outline:2px solid #1877F2;outline-offset:1px}' +
    '.mbx-pill:disabled{background:#F0F2F5;color:#8A8D91;cursor:default}' +
    '.mbx-toggle{min-width:74px}.mbx-copy{min-width:64px}' +
    '.mbx-lang{font-size:12px;color:#65676B;white-space:nowrap}' +
    '.mbx-tbox{margin-top:4px;box-sizing:border-box;background:#fff;border:1px solid #E4E6EB;color:#1C1E21;font-size:14px;line-height:1.45;' +
    'padding:8px 12px;border-radius:12px;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;-webkit-user-select:text;cursor:text}' +
    '.mbx-tbox::selection,.mbx-tbox *::selection{background:#CCE4FF}' +
    '.mbx-tbox.mbx-note{color:#65676B}' +
    '.mbx-tbox.mbx-err{color:#B3261E;white-space:normal;display:flex;align-items:center;gap:10px;flex-wrap:wrap}' +
    '.mbx-tbox.mbx-err .mbx-pill{flex:none}';

  const cache = root.createFifoCache(root.BUBBLE_CACHE_MAX); // 메시지 ID → { text, detectedLang, targetLang }
  const states = new Map(); // 메시지 ID → { open, busy, copied: 'src'|'tr'|'fail'|null }
  const errors = new Map(); // 메시지 ID → { code, text }
  const copyTimers = new Map();
  let notifiedThread = null; // "말풍선 버튼을 표시하지 못했습니다"를 알린 대화(대화마다 1회)
  let scanQueued = false;

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt !== undefined) e.textContent = txt;
    return e;
  }

  function enabled() {
    const s = util.settings();
    return !s || s.bubbleButtonsEnabled !== false;
  }

  function targetLang() {
    const s = util.settings();
    return (s && typeof s.bubbleTargetLang === 'string' && s.bubbleTargetLang) || 'KO';
  }

  // 금지 사항 9: 로그인·보안 확인·캡차 화면이면 참.
  function blockedNow() {
    return typeof sel.blockedScreen === 'function' && !!sel.blockedScreen();
  }

  function stateOf(id) {
    let s = states.get(id);
    if (!s) { s = { open: false, busy: false, copied: null }; states.set(id, s); }
    return s;
  }

  function idOf(b) { return b ? b.getAttribute('data-message-id') : null; }
  function isRow(n) { return !!n && n.nodeType === 1 && n.getAttribute('data-mbx') === 'actions'; }

  // Meta가 화면을 다시 그려 요소가 바뀌어도 메시지 ID로 다시 찾는다.
  function findBubble(id) {
    const r = sel.messageRegion();
    if (!r || !id) return null;
    const all = r.querySelectorAll('[data-message-id]');
    for (let i = 0; i < all.length; i++) if (all[i].getAttribute('data-message-id') === id) return all[i];
    return null;
  }

  function findRow(id) {
    const all = document.querySelectorAll('[data-mbx="actions"]');
    for (let i = 0; i < all.length; i++) if (all[i].getAttribute('data-mbx-id') === id) return all[i];
    return null;
  }

  function allRows() { return Array.prototype.slice.call(document.querySelectorAll('[data-mbx="actions"]')); }

  function removeAll() { allRows().forEach(function (h) { h.remove(); }); }

  // ---- 요소 만들기 ----
  function makeRow(bubble) {
    const id = idOf(bubble);
    const host = document.createElement('div');
    host.setAttribute('data-mbx', 'actions');
    host.setAttribute('data-mbx-id', id);
    // 좌우 정렬은 부모의 align-items 를 그대로 따른다. 줄 안의 정렬(보낸 메시지는 오른쪽)만 맞춘다.
    let side = 'in';
    try { if (getComputedStyle(bubble.parentNode).alignItems === 'flex-end') side = 'out'; } catch (e) { /* 왼쪽 */ }
    host.setAttribute('data-side', side);
    root.inject.shieldEvents(host);
    const sh = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    sh.appendChild(style);
    sh.appendChild(el('div', 'mbx-wrap'));
    render(host, id);
    return host;
  }

  function button(cls, act, label, aria, onClick) {
    const b = el('button', 'mbx-pill ' + cls, label);
    b.type = 'button';
    b.setAttribute('data-act', act);
    b.setAttribute('aria-label', aria || label);
    // 입력창의 포커스와 커서를 유지한다(2장 10번). 번역 상자에서는 막지 않는다(글자 선택).
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('click', onClick);
    return b;
  }

  function langLabel(c) {
    const target = root.langName(c.targetLang);
    return c.detectedLang ? root.langName(c.detectedLang) + ' → ' + target : target;
  }

  function sameLang(c) { return !!c.detectedLang && root.sameLanguage(c.detectedLang, c.targetLang); }

  // 메시지 ID 의 상태로 줄 전체를 다시 그린다(Meta가 다시 그린 뒤에도 같은 모습으로 복원된다).
  function render(host, id) {
    const sh = host.shadowRoot;
    const wrap = sh && sh.querySelector('.mbx-wrap');
    if (!wrap) return;
    const st = stateOf(id);
    const tl = targetLang();
    const hit = cache.get(id);
    const res = hit && hit.targetLang === tl ? hit : null;
    const err = errors.get(id);
    // 열려 있는데 보여 줄 결과도 오류도 없으면(캐시에서 밀려남, 설정 변경) 닫힌 상태로 그린다.
    if (st.open && !st.busy && !res && !err) st.open = false;
    wrap.textContent = '';
    const row = el('div', 'mbx-row');
    const toggleLabel = st.busy ? '번역 중…' : st.open ? '번역 숨기기' : '번역 보기';
    const tg = button('mbx-toggle', 'toggle', toggleLabel, toggleLabel, function () { onToggle(id); });
    tg.disabled = st.busy;
    row.appendChild(tg);
    if (st.open && res && !sameLang(res)) row.appendChild(el('span', 'mbx-lang', langLabel(res))); // 같은 언어면 안내만 보인다
    row.appendChild(button('mbx-copy', 'copy-src', st.copied === 'src' ? '복사됨' : st.copied === 'src-fail' ? '복사 실패' : '원문 복사',
      '말풍선 원문 복사', function () { onCopy(id, 'src'); }));
    if (st.open && res && !sameLang(res)) {
      row.appendChild(button('mbx-copy', 'copy-tr', st.copied === 'tr' ? '복사됨' : st.copied === 'tr-fail' ? '복사 실패' : '번역 복사',
        '번역문 복사', function () { onCopy(id, 'tr'); }));
    }
    wrap.appendChild(row);
    if (!st.open) return;
    let box = null;
    if (err) {
      box = el('div', 'mbx-tbox mbx-err');
      box.appendChild(el('span', '', err.text));
      if (err.code === 'NO_KEY' || err.code === 'PERMISSION_OFF') {
        const section = err.code === 'NO_KEY' ? 'translate' : 'start';
        box.appendChild(button('', 'open-settings', '설정 열기', '설정 열기', function () { util.send('OPEN_OPTIONS', { section: section }); }));
      }
      box.appendChild(button('', 'retry', '다시 시도', '번역 다시 시도', function () { errors.delete(id); stateOf(id).open = false; onToggle(id); }));
    } else if (res && sameLang(res)) {
      box = el('div', 'mbx-tbox mbx-note', root.sameLanguage(res.targetLang, 'KO') ? '이미 한국어입니다' : '이미 ' + root.langName(res.targetLang) + '입니다');
    } else if (res) {
      box = el('div', 'mbx-tbox', res.text);
    }
    if (!box) return;
    box.style.maxWidth = boxMaxWidth(id);
    wrap.appendChild(box);
  }

  // 내용에 맞추되 최대 폭은 말풍선 폭과 360px 중 큰 값, 대화 영역 폭의 80%를 넘지 않는다(3-5).
  function boxMaxWidth(id) {
    try {
      const b = findBubble(id);
      const r = sel.messageRegion();
      const bw = b ? b.getBoundingClientRect().width : 0;
      const rw = r ? r.getBoundingClientRect().width : 0;
      const w = Math.max(bw, 360);
      return Math.round(rw > 0 ? Math.min(w, rw * 0.8) : w) + 'px';
    } catch (e) { return '360px'; }
  }

  function rerender(id) {
    const h = findRow(id);
    if (h) render(h, id);
  }

  // 번역 상자가 대화 영역 아래로 잘리면 다 보이는 만큼만 스크롤한다. 맨 아래 말풍선이면 맨 아래로 맞춘다(3-6).
  function revealBox(id) {
    try {
      const h = findRow(id);
      const r = sel.messageRegion();
      if (!h || !r) return;
      const box = h.shadowRoot.querySelector('.mbx-tbox');
      if (!box) return;
      const over = box.getBoundingClientRect().bottom - r.getBoundingClientRect().bottom + 8;
      if (over <= 0) return;
      const all = r.querySelectorAll('[data-message-id]');
      const last = all.length && idOf(all[all.length - 1]) === id;
      let reverse = false;
      try { reverse = getComputedStyle(r).flexDirection === 'column-reverse'; } catch (e) { /* 기본 방향 */ }
      if (last) r.scrollTop = reverse ? 0 : r.scrollHeight;
      else r.scrollTop = (r.scrollTop || 0) + over;
    } catch (e) { console.debug('reveal failed'); }
  }

  // ---- 버튼 ----
  async function onToggle(id) {
    try {
      if (blockedNow()) { removeAll(); return; }
      const st = stateOf(id);
      if (st.busy) return;
      if (st.open) { st.open = false; rerender(id); return; }
      const tl = targetLang();
      const hit = cache.get(id);
      if ((hit && hit.targetLang === tl) || errors.has(id)) { st.open = true; rerender(id); revealBox(id); return; }
      const b = findBubble(id);
      const t = b ? sel.bubbleTextEl(b) : null; // 누른 말풍선만 읽는다
      const text = t ? (t.innerText || '') : '';
      if (!text.trim()) return;
      st.busy = true; rerender(id);
      let res;
      try { res = await util.send('TRANSLATE', { text: text, targetLang: tl, purpose: 'bubble' }); }
      finally { st.busy = false; }
      if (blockedNow()) { removeAll(); return; } // 기다리는 사이 로그인·보안 확인 화면이 떴다
      if (res && res.ok && typeof res.text === 'string') {
        errors.delete(id);
        cache.set(id, { text: res.text, detectedLang: res.detectedLang, targetLang: tl });
      } else {
        errors.set(id, { code: res && res.code, text: root.bubbleErrorText(res) });
      }
      st.open = true;
      rerender(id);
      revealBox(id);
    } catch (err) { console.debug('bubble translate failed'); }
  }

  async function onCopy(id, which) {
    if (blockedNow()) { removeAll(); return; }
    const st = stateOf(id);
    let ok = false;
    try {
      let t = null;
      if (which === 'src') {
        const b = findBubble(id);
        const tEl = b ? sel.bubbleTextEl(b) : null; // 번역문이 아니라 항상 원문 요소
        t = tEl ? (tEl.innerText || '') : null;
      } else {
        const hit = cache.get(id);
        t = hit && hit.targetLang === targetLang() ? hit.text : null;
      }
      if (t !== null) { await navigator.clipboard.writeText(t); ok = true; }
    } catch (err) { console.debug('bubble copy failed'); }
    st.copied = ok ? which : which + '-fail';
    rerender(id);
    clearTimeout(copyTimers.get(id));
    copyTimers.set(id, setTimeout(function () { st.copied = null; copyTimers.delete(id); rerender(id); }, COPIED_MS));
  }

  // ---- 넣기와 정리 ----
  // 한 번의 변화에 대한 넣기를 한 번에 한다. 실패한 말풍선은 건너뛰고 오류를 던지지 않는다(2장 7번).
  function scan() {
    try {
      if (!enabled() || blockedNow()) { removeAll(); return; }
      const region = sel.messageRegion();
      // 대화 영역 밖에 남은 줄, 말풍선이 사라진 줄은 지운다(2장 5번).
      allRows().forEach(function (h) {
        const p = h.previousElementSibling;
        if (!region || !region.contains(h) || !p || idOf(p) !== h.getAttribute('data-mbx-id') || !sel.bubbleHasText(p)) h.remove();
      });
      if (!region) return;
      const bubbles = region.querySelectorAll('[data-message-id]');
      const todo = [];
      let textBubbles = 0;
      let placed = 0;
      for (let i = 0; i < bubbles.length; i++) {
        const b = bubbles[i];
        if (!sel.bubbleHasText(b)) continue; // 구조만 본다(본문을 읽지 않는다)
        textBubbles++;
        const nx = b.nextElementSibling;
        if (isRow(nx) && nx.getAttribute('data-mbx-id') === idOf(b)) { placed++; continue; }
        todo.push(b);
      }
      if (todo.length) {
        root.inject.keepScroll(region, function () {
          todo.forEach(function (b) {
            try {
              const nx = b.nextElementSibling;
              if (isRow(nx)) nx.remove(); // 다른 ID 의 줄이 붙어 있으면 바꾼다
              b.parentNode.insertBefore(makeRow(b), b.nextSibling);
              placed++;
            } catch (e) { console.debug('action row insert skipped'); }
          });
        });
      }
      if (textBubbles > 0 && placed === 0) {
        const tid = sel.threadIdFrom(location.href);
        if (notifiedThread !== tid) {
          notifiedThread = tid;
          if (root.composer && typeof root.composer.notify === 'function') root.composer.notify(NOTICE_NO_ROWS, 'error');
          else util.toast(NOTICE_NO_ROWS);
        }
      }
    } catch (err) { console.debug('bubbles scan failed'); }
  }

  function schedule() {
    if (scanQueued) return;
    scanQueued = true;
    const run = function () { scanQueued = false; scan(); };
    if (document.hidden) setTimeout(run, 50); else requestAnimationFrame(run);
  }

  // 자기 요소로 인한 변화는 무시한다(넣기가 관찰자를 다시 깨워 무한 반복되지 않게, 2장 6번).
  function ownOnly(records) {
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const nodes = Array.prototype.slice.call(r.addedNodes || []).concat(Array.prototype.slice.call(r.removedNodes || []));
      if (!nodes.length) return false;
      for (let j = 0; j < nodes.length; j++) if (!isRow(nodes[j]) && nodes[j].getAttribute && nodes[j].getAttribute('data-mbx') !== 'toolbar') return false;
    }
    return true;
  }

  function applySettings() {
    if (!enabled()) { removeAll(); return; }
    // 번역 결과 언어가 바뀌면 이전 언어로 번역한 결과는 쓰지 않는다: 열린 상자를 닫는다.
    const tl = targetLang();
    states.forEach(function (st, id) {
      const hit = cache.get(id);
      if (st.open && hit && hit.targetLang !== tl) st.open = false;
    });
    errors.clear();
    allRows().forEach(function (h) { render(h, h.getAttribute('data-mbx-id')); });
    schedule();
  }

  function init() {
    new MutationObserver(function (records) { if (!ownOnly(records)) schedule(); })
      .observe(document.documentElement, { childList: true, subtree: true });
    util.onMessage('SETTINGS_CHANGED', applySettings);
    util.onInboxChange(schedule);
    const t = setInterval(schedule, RESCAN_MS); // 로그인 화면 전환 등 놓친 변화를 위한 안전장치
    if (t && typeof t.unref === 'function') t.unref(); // node 테스트가 끝나도록
    schedule();
  }

  root.bubbles = {
    _cache: cache,
    // 테스트용(test/bubbles.test.js)
    _test: {
      scan: scan,
      resetState: function () {
        states.clear(); errors.clear(); notifiedThread = null;
        copyTimers.forEach(function (t) { clearTimeout(t); }); copyTimers.clear();
        cache._clear && cache._clear();
      }
    }
  };

  if (typeof document !== 'undefined' && root.sel && root.util) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }
})(self.MBX = self.MBX || {});
