// R2~R4: 말풍선 도구 모음(번역, 복사). 도구 모음 1개를 Shadow DOM 안에 두고 재사용한다.
// mouseover에서는 말풍선의 위치와 본문 요소의 존재만 본다. 본문 텍스트는 버튼을 눌렀을 때만 읽는다.
// fetch와 chrome.storage는 쓰지 않는다. 로그는 console.debug만, 본문은 넣지 않는다.
(function (root) {
  const sel = root.sel;
  const util = root.util;
  const HIDE_DELAY_MS = 300;
  const COPIED_MS = 1500;

  const CSS =
    '.mbx-btools{position:fixed;display:none;gap:4px;font:12px/1.2 system-ui,sans-serif;color:#222}' +
    '.mbx-btools button{font:inherit;padding:3px 8px;border:1px solid #bbb;border-radius:10px;background:#fff;color:#222;cursor:pointer}' +
    '.mbx-btools button:hover{background:#eef}.mbx-btools button[disabled]{opacity:.6;cursor:default}' +
    '.mbx-bresult{position:fixed;display:none;box-sizing:border-box;max-width:360px;padding:8px 10px;border:1px solid #bbb;' +
    'border-radius:8px;background:#fffbe6;color:#222;font:13px/1.45 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.2)}' +
    '.mbx-bresult .mbx-blang{font-size:11px;color:#777;margin-bottom:2px}' +
    '.mbx-bresult .mbx-btext{white-space:pre-wrap;word-break:break-word}' +
    '.mbx-bresult a{color:#06c;cursor:pointer;text-decoration:underline;margin-left:6px}';

  const cache = root.createFifoCache(root.BUBBLE_CACHE_MAX);
  const pending = new Set(); // 번역 중인 메시지 ID
  let ui = null;
  let curBubble = null;      // 도구 모음이 붙어 있는 말풍선
  let hideTimer = null;
  let copyTimer = null;
  let result = null;         // { id, kind: 'ok'|'info'|'error', lang, text, code } 표시 중인 번역 상자

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

  function idOf(b) { return b ? b.getAttribute('data-message-id') : null; }

  // Meta가 화면을 다시 그려 요소가 바뀌어도 메시지 ID로 다시 찾는다.
  function findBubble(id) {
    const r = sel.messageRegion();
    if (!r || !id) return null;
    const all = r.querySelectorAll('[data-message-id]');
    for (let i = 0; i < all.length; i++) if (all[i].getAttribute('data-message-id') === id) return all[i];
    return null;
  }

  function build() {
    const h = util.host();
    const style = document.createElement('style');
    style.textContent = CSS;
    h.appendChild(style);
    const bar = el('div', 'mbx-btools');
    const trBtn = el('button', 'mbx-btr', '번역');
    trBtn.type = 'button'; trBtn.setAttribute('aria-label', '이 메시지 번역');
    const cpBtn = el('button', 'mbx-bcp', '복사');
    cpBtn.type = 'button'; cpBtn.setAttribute('aria-label', '이 메시지 복사');
    bar.appendChild(trBtn); bar.appendChild(cpBtn);
    const box = el('div', 'mbx-bresult');
    h.appendChild(bar); h.appendChild(box);
    ui = { bar, trBtn, cpBtn, box };

    // 버튼을 눌러도 Meta 쪽 포커스와 선택이 바뀌지 않게 한다.
    bar.addEventListener('mousedown', function (e) { e.preventDefault(); });
    bar.addEventListener('mouseenter', cancelHide);
    bar.addEventListener('mouseleave', scheduleHide);
    trBtn.addEventListener('click', onTranslate);
    cpBtn.addEventListener('click', onCopy);
  }

  // ---- 표시/숨김 ----
  function cancelHide() { clearTimeout(hideTimer); hideTimer = null; }
  function scheduleHide() {
    cancelHide();
    hideTimer = setTimeout(hideBar, HIDE_DELAY_MS);
  }
  function hideBar() {
    cancelHide();
    if (!ui) return;
    ui.bar.style.display = 'none';
    curBubble = null;
  }

  function placeBar(b) {
    const r = b.getBoundingClientRect();
    ui.bar.style.display = 'flex';
    const h = ui.bar.offsetHeight || 24;
    // 말풍선 위쪽 모서리에 살짝 겹쳐, 마우스가 말풍선에서 도구 모음으로 끊김 없이 이동하게 한다.
    const top = Math.max(0, r.top - h + 4);
    const left = Math.min(Math.max(0, r.left), Math.max(0, window.innerWidth - (ui.bar.offsetWidth || 100)));
    ui.bar.style.top = top + 'px';
    ui.bar.style.left = left + 'px';
  }

  function syncTrButton() {
    if (!ui) return;
    const id = idOf(curBubble);
    const busy = !!id && pending.has(id);
    ui.trBtn.disabled = busy;
    ui.trBtn.textContent = busy ? '번역 중…' : '번역';
  }

  function showBarFor(b) {
    curBubble = b;
    placeBar(b);
    syncTrButton();
    resetCopyLabel();
  }

  function resetCopyLabel() {
    clearTimeout(copyTimer); copyTimer = null;
    if (ui) ui.cpBtn.textContent = '복사';
  }

  function onOver(e) {
    try {
      if (!ui || !enabled() || sel.dialogOpen()) return;
      const path = e.composedPath ? e.composedPath() : [];
      if (path.indexOf(ui.bar) >= 0) { cancelHide(); return; }
      const b = sel.bubbleFrom(e.target);
      if (!b || !sel.bubbleTextEl(b)) { if (curBubble) scheduleHide(); return; }
      cancelHide();
      if (b !== curBubble) showBarFor(b);
    } catch (err) { console.debug('bubbles over failed'); }
  }

  function onOut(e) {
    try {
      if (!ui || !curBubble) return;
      const to = e.relatedTarget;
      // 말풍선 안에서의 이동은 무시한다. 도구 모음은 Shadow DOM이라 자체 mouseenter 로 처리한다.
      if (to && curBubble.contains(to)) return;
      scheduleHide();
    } catch (err) { console.debug('bubbles out failed'); }
  }

  // ---- 번역 상자 ----
  function renderResult() {
    if (!ui) return;
    const box = ui.box;
    if (!result || !enabled()) { box.style.display = 'none'; return; }
    const b = findBubble(result.id);
    if (!b || sel.dialogOpen()) { box.style.display = 'none'; return; }
    const r = b.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    box.style.maxWidth = Math.min(360, Math.max(160, window.innerWidth - 16)) + 'px';
    box.style.top = Math.min(r.bottom + 4, window.innerHeight - 40) + 'px';
    box.style.left = Math.min(Math.max(0, r.left), Math.max(0, window.innerWidth - 200)) + 'px';
  }

  function fillResult() {
    const box = ui.box;
    box.textContent = '';
    if (!result) return;
    if (result.kind === 'ok' && result.lang) box.appendChild(el('div', 'mbx-blang', result.lang));
    const t = el('div', 'mbx-btext', result.text);
    if (result.kind === 'error' && result.code === 'NO_KEY') {
      const a = el('a', '', '설정 열기');
      a.setAttribute('role', 'button'); a.tabIndex = 0;
      const open = function () { util.send('OPEN_OPTIONS'); };
      a.addEventListener('click', open);
      a.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      t.appendChild(a);
    }
    box.appendChild(t);
  }

  function showResult(r) {
    result = r;
    fillResult();
    renderResult();
  }

  function hideResult() { result = null; if (ui) { ui.box.style.display = 'none'; ui.box.textContent = ''; } }

  function resultFromCache(id, c) {
    if (c.detectedLang === 'KO' && c.targetLang === 'KO') return { id: id, kind: 'info', text: '이미 한국어입니다' };
    return { id: id, kind: 'ok', lang: root.langPair(c.detectedLang, c.targetLang), text: c.text };
  }

  // ---- 버튼 ----
  async function onTranslate() {
    try {
      const b = curBubble;
      const id = idOf(b);
      if (!id || pending.has(id)) return;
      if (result && result.id === id) { hideResult(); return; } // 토글
      const tl = targetLang();
      const hit = cache.get(id);
      if (hit && hit.targetLang === tl) { showResult(resultFromCache(id, hit)); return; }
      const t = sel.bubbleTextEl(b);
      const text = t ? (t.innerText || '') : '';
      if (!text.trim()) return;
      pending.add(id); syncTrButton();
      let res;
      try { res = await util.send('TRANSLATE', { text: text, targetLang: tl, purpose: 'bubble' }); }
      finally { pending.delete(id); syncTrButton(); }
      if (res && res.ok && typeof res.text === 'string') {
        const entry = { text: res.text, detectedLang: res.detectedLang, targetLang: tl };
        cache.set(id, entry);
        showResult(resultFromCache(id, entry));
      } else {
        const code = res && res.code;
        showResult({ id: id, kind: 'error', code: code, text: root.bubbleErrorText(res) });
      }
    } catch (err) { console.debug('bubble translate failed'); }
  }

  async function onCopy() {
    const btn = ui.cpBtn;
    let ok = false;
    try {
      const t = sel.bubbleTextEl(curBubble); // 번역문이 아니라 항상 원문 요소
      if (t) { await navigator.clipboard.writeText(t.innerText || ''); ok = true; }
    } catch (err) { console.debug('bubble copy failed'); }
    btn.textContent = ok ? '복사됨' : '복사 실패';
    clearTimeout(copyTimer);
    copyTimer = setTimeout(function () { copyTimer = null; btn.textContent = '복사'; }, COPIED_MS);
  }

  // ---- 스크롤, 설정 ----
  let rafPending = false;
  function onScroll() {
    if (!ui) return;
    hideBar(); // 스크롤 시 도구 모음은 즉시 숨긴다.
    if (result && !rafPending) {
      rafPending = true;
      requestAnimationFrame(function () { rafPending = false; renderResult(); });
    }
  }

  function applySettings() {
    if (enabled()) return;
    hideBar(); hideResult();
  }

  function init() {
    build();
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', function () { hideBar(); renderResult(); });
    util.onMessage('SETTINGS_CHANGED', applySettings);
    util.onInboxChange(function () { hideBar(); hideResult(); });
  }

  root.bubbles = { _cache: cache };

  if (typeof document !== 'undefined' && root.sel && root.util) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }
})(self.MBX = self.MBX || {});
