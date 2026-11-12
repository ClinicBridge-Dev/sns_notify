// 입력창 주변 UI(막대, 언어 버튼, 빠른 메시지 창)와 입력창 내용 넣기. R5(전송 가로채기)는 Task 13에서 이 파일에 더한다.
// fetch와 chrome.storage는 쓰지 않는다. 입력창 내용은 paste 이벤트나 execCommand로만 바꾸고 DOM을 직접 고치지 않는다.
// 로그는 console.debug만, 본문은 넣지 않는다.
(function (root) {
  const sel = root.sel;
  const util = root.util;
  const INSERT_VERIFY_MS = 500;
  const POLL_MS = 50;
  const TICK_MS = 300;

  // DeepL 언어 코드(기획서 5장). 표시 이름은 안내용이다.
  const LANGS = [
    ['EN-US', '영어(미국)'], ['EN-GB', '영어(영국)'], ['ZH-HANS', '중국어(간체)'], ['ZH-HANT', '중국어(번체)'],
    ['JA', '일본어'], ['ES', '스페인어'], ['FR', '프랑스어'], ['DE', '독일어'], ['RU', '러시아어'],
    ['VI', '베트남어'], ['TH', '태국어'], ['ID', '인도네시아어'], ['AR', '아랍어'], ['PT-BR', '포르투갈어(브라질)']
  ];

  // ================= 입력창 접근 =================
  function normalize(s) {
    return String(s).replace(/[​﻿]/g, '').replace(/\s+/g, ' ').trim();
  }

  function text() {
    const el = sel.composer();
    if (!el) return '';
    const t = (el.innerText || el.textContent || '').replace(/[​﻿]/g, '');
    return t.trim() === '' ? '' : t;
  }

  // 마지막으로 입력창 안에 있던 선택 범위. 막대 버튼을 눌러도 커서 위치를 잃지 않게 한다.
  let savedRange = null;
  function trackSelection() {
    document.addEventListener('selectionchange', function () {
      const el = sel.composer();
      const s = document.getSelection();
      if (el && s && s.rangeCount && el.contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange();
    });
  }

  function nextFrame() {
    return new Promise(function (resolve) {
      if (document.hidden) { setTimeout(resolve, 50); return; }
      let done = false;
      const fin = function () { if (!done) { done = true; resolve(); } };
      requestAnimationFrame(fin);
      setTimeout(fin, 100); // rAF가 멈춘 경우의 안전장치
    });
  }

  function selectAll(el) {
    const s = document.getSelection();
    const r = document.createRange();
    r.selectNodeContents(el);
    s.removeAllRanges();
    s.addRange(r);
  }

  function restoreCaret(el) {
    const s = document.getSelection();
    if (s.rangeCount && el.contains(s.anchorNode)) return;
    const r = (savedRange && el.contains(savedRange.startContainer) && el.contains(savedRange.endContainer)) ? savedRange : null;
    s.removeAllRanges();
    if (r) { s.addRange(r); return; }
    const end = document.createRange();
    end.selectNodeContents(el);
    end.collapse(false);
    s.addRange(end);
  }

  function pasteText(el, t) {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }

  function execInsert(el, t) {
    try { return document.execCommand('insertText', false, t); } catch (e) { return false; }
  }

  // 500ms 안에 입력창에 반영됐는지 본다.
  function reflected(replaceAll, before, want) {
    const now = normalize(text());
    if (replaceAll) return now === want;
    return now !== before && now.indexOf(want) >= 0;
  }

  function waitReflected(replaceAll, before, want) {
    return new Promise(function (resolve) {
      const t0 = Date.now();
      const check = function () {
        if (reflected(replaceAll, before, want)) { resolve(true); return; }
        if (Date.now() - t0 >= INSERT_VERIFY_MS) { resolve(false); return; }
        setTimeout(check, POLL_MS);
      };
      check();
    });
  }

  // 1순위 합성 붙여넣기, 2순위 execCommand('insertText'). U6 미확인 상태이므로 결과를 반드시 확인해 돌려준다.
  // replaceAll: 전체 선택 → 한 프레임 대기(8-5 교체 2번) → 넣기. 아니면 현재 커서 위치에 넣는다.
  async function insertText(t, opts) {
    const el = sel.composer();
    if (!el || typeof t !== 'string' || t === '') return false;
    const replaceAll = !!(opts && opts.replaceAll);
    const want = normalize(t);
    const methods = [pasteText, execInsert];
    for (let i = 0; i < methods.length; i++) {
      const cur = sel.composer();
      if (cur !== el) return false; // 도중에 입력창이 바뀜
      el.focus();
      if (replaceAll) { selectAll(el); await nextFrame(); } else { restoreCaret(el); }
      const before = normalize(text());
      methods[i](el, t);
      if (await waitReflected(replaceAll, before, want)) return true;
    }
    return false;
  }

  // ================= 대화별 언어 =================
  let lang = null;       // 언어 코드 | 'OFF' | null(불러오는 중)
  let langThread = null; // lang 이 속한 대화
  let loadingThread = null;
  let retryTimer = null;

  function currentThread() { return sel.threadIdFrom(location.href); }

  // 대화가 바뀐 직후(감지 전)에도 이전 대화의 값을 돌려주지 않는다.
  function currentLang() {
    const tid = currentThread();
    return (tid && langThread === tid) ? lang : null;
  }

  function loadLang() {
    clearTimeout(retryTimer);
    const tid = currentThread();
    loadingThread = tid;
    if (!tid || langThread === tid) return;
    lang = null; langThread = null;
    const attempt = function () {
      if (currentThread() !== tid || langThread === tid) return;
      util.send('GET_THREAD_LANG', { threadId: tid }).then(function (res) {
        // 응답의 threadId 가 지금 대화와 같고 아직 값이 없을 때만 적용한다.
        if (res && typeof res.lang === 'string' && res.threadId === tid && currentThread() === tid && langThread !== tid) {
          lang = res.lang; langThread = tid; render();
        }
      });
      retryTimer = setTimeout(attempt, root.THREAD_LANG_RETRY_MS || 500);
    };
    attempt();
  }

  function setLang(code) {
    const tid = currentThread();
    if (!tid || currentLang() === null) return; // 불러오는 중에는 바꾸지 않는다
    lang = code; langThread = tid;
    render();
    util.send('SET_THREAD_LANG', { threadId: tid, lang: code }).then(function (res) {
      if (!res || res.ok !== true) util.toast('언어 설정을 저장하지 못했습니다');
    });
  }

  // ================= 빠른 메시지 =================
  let quick = null;       // 캐시: items 배열. null 이면 아직 못 받음
  let quickDirty = true;

  function loadQuick() {
    if (!quickDirty && quick) return Promise.resolve(quick);
    return util.send('GET_QUICK_REPLIES').then(function (res) {
      if (res && Array.isArray(res.items)) { quick = res.items; quickDirty = false; return quick; }
      return null;
    });
  }

  function matches(item, q) {
    if (!q) return true;
    const hay = [item.title, item.text].concat(Array.isArray(item.tags) ? item.tags : []).join('\n').toLowerCase();
    return hay.indexOf(q.toLowerCase()) >= 0;
  }

  // ================= UI =================
  const CSS =
    '.mbx-bar{position:fixed;display:none;gap:6px;align-items:center;font:12px/1.2 system-ui,sans-serif;color:#222}' +
    '.mbx-bar button{font:inherit;padding:4px 10px;border:1px solid #bbb;border-radius:12px;background:#fff;color:#222;cursor:pointer}' +
    '.mbx-bar button:hover{background:#eef}.mbx-bar button[disabled]{opacity:.6;cursor:default}' +
    '.mbx-pop{position:absolute;left:0;bottom:100%;margin-bottom:6px;min-width:200px;max-height:260px;overflow:auto;background:#fff;' +
    'border:1px solid #bbb;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.25);padding:4px;display:none}' +
    '.mbx-pop.mbx-open{display:block}' +
    '.mbx-opt{display:block;width:100%;text-align:left;border:0;border-radius:6px;padding:6px 8px;background:transparent}' +
    '.mbx-opt.mbx-sel{background:#dde7ff}' +
    '.mbx-qpanel{width:340px;max-height:320px;display:none;flex-direction:column;padding:6px}' +
    '.mbx-qpanel.mbx-open{display:flex}' +
    '.mbx-qsearch{font:inherit;padding:6px 8px;border:1px solid #bbb;border-radius:6px;margin-bottom:4px;color:#222;background:#fff}' +
    '.mbx-qlist{overflow:auto;flex:1}' +
    '.mbx-qitem{display:block;width:100%;text-align:left;border:0;border-radius:6px;padding:6px 8px;background:transparent;cursor:pointer}' +
    '.mbx-qitem.mbx-sel{background:#dde7ff}' +
    '.mbx-qtitle{font-weight:600}.mbx-qbody{color:#555;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.mbx-empty{padding:8px;color:#555}.mbx-empty a{color:#06c;cursor:pointer;text-decoration:underline}' +
    '.mbx-outline{position:fixed;display:none;box-sizing:border-box;border:2px solid #2d8cff;border-radius:10px;pointer-events:none}';

  let ui = null;
  let observed = null;
  let ro = null;
  let rafPending = false;
  let qIndex = 0;
  let qFiltered = [];

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt !== undefined) e.textContent = txt;
    return e;
  }

  function build() {
    const h = util.host();
    const style = document.createElement('style');
    style.textContent = CSS;
    h.appendChild(style);

    const bar = el('div', 'mbx-bar');
    const quickBtn = el('button', 'mbx-quick-btn', '빠른 메시지');
    const langBtn = el('button', 'mbx-lang-btn', '번역: …');
    const langMenu = el('div', 'mbx-pop mbx-lang-menu');
    const qpanel = el('div', 'mbx-pop mbx-qpanel');
    const qsearch = el('input', 'mbx-qsearch');
    qsearch.type = 'text'; qsearch.placeholder = '검색 (제목, 본문, 태그)';
    const qlist = el('div', 'mbx-qlist');
    qpanel.appendChild(qsearch); qpanel.appendChild(qlist);
    bar.appendChild(quickBtn); bar.appendChild(langBtn); bar.appendChild(langMenu); bar.appendChild(qpanel);
    const outline = el('div', 'mbx-outline');
    h.appendChild(bar); h.appendChild(outline);
    ui = { bar, quickBtn, langBtn, langMenu, qpanel, qsearch, qlist, outline };

    // 버튼을 눌러도 입력창의 포커스와 커서가 유지되게 한다(검색창은 제외).
    bar.addEventListener('mousedown', function (e) { if (e.target !== qsearch) e.preventDefault(); });
    quickBtn.addEventListener('click', function () { toggleQuick(); });
    langBtn.addEventListener('click', function () { toggleLangMenu(); });
    qsearch.addEventListener('input', function () { qIndex = 0; renderQuick(); });
    qsearch.addEventListener('keydown', onQuickKey);
    document.addEventListener('mousedown', function (e) {
      const path = e.composedPath ? e.composedPath() : [];
      if (path.indexOf(ui.bar) < 0) closePops();
    }, true);
  }

  function closePops() {
    if (!ui) return;
    ui.langMenu.classList.remove('mbx-open');
    ui.qpanel.classList.remove('mbx-open');
  }

  function toggleLangMenu() {
    if (!ui) return;
    const open = !ui.langMenu.classList.contains('mbx-open');
    closePops();
    if (!open || currentLang() === null) return;
    ui.langMenu.textContent = '';
    const cur = currentLang();
    const add = function (code, label) {
      const b = el('button', 'mbx-opt' + (cur === code ? ' mbx-sel' : ''), label);
      b.addEventListener('click', function () { closePops(); setLang(code); });
      ui.langMenu.appendChild(b);
    };
    add('OFF', '끔 (번역하지 않고 그대로 전송)');
    LANGS.forEach(function (l) { add(l[0], l[0] + '  ' + l[1]); });
    ui.langMenu.classList.add('mbx-open');
  }

  function toggleQuick() {
    if (!ui) return;
    const open = !ui.qpanel.classList.contains('mbx-open');
    closePops();
    if (!open) return;
    ui.qsearch.value = ''; qIndex = 0;
    ui.qpanel.classList.add('mbx-open');
    ui.qlist.textContent = '';
    ui.qlist.appendChild(el('div', 'mbx-empty', '불러오는 중…'));
    loadQuick().then(function (items) {
      if (!ui.qpanel.classList.contains('mbx-open')) return;
      if (items === null) { ui.qlist.textContent = ''; ui.qlist.appendChild(el('div', 'mbx-empty', '빠른 메시지를 불러오지 못했습니다')); return; }
      renderQuick();
      ui.qsearch.focus();
    });
  }

  function renderQuick() {
    const items = quick || [];
    ui.qlist.textContent = '';
    if (items.length === 0) {
      const d = el('div', 'mbx-empty', '설정에서 빠른 메시지를 추가하세요 ');
      const a = el('a', null, '설정 열기');
      a.addEventListener('click', function () { util.send('OPEN_OPTIONS'); });
      d.appendChild(a);
      ui.qlist.appendChild(d);
      qFiltered = [];
      return;
    }
    const q = ui.qsearch.value.trim();
    qFiltered = items.filter(function (it) { return matches(it, q); });
    if (qFiltered.length === 0) { ui.qlist.appendChild(el('div', 'mbx-empty', '검색 결과가 없습니다')); return; }
    if (qIndex >= qFiltered.length) qIndex = qFiltered.length - 1;
    qFiltered.forEach(function (it, i) {
      const b = el('button', 'mbx-qitem' + (i === qIndex ? ' mbx-sel' : ''));
      b.appendChild(el('div', 'mbx-qtitle', it.title));
      b.appendChild(el('div', 'mbx-qbody', String(it.text).replace(/\s+/g, ' ').slice(0, 80)));
      b.addEventListener('click', function () { chooseQuick(it); });
      ui.qlist.appendChild(b);
      if (i === qIndex && b.scrollIntoView) b.scrollIntoView({ block: 'nearest' });
    });
  }

  function onQuickKey(e) {
    e.stopPropagation(); // 이 창의 키는 Meta로 보내지 않는다(Task 13 가로채기 대상도 아니다)
    if (e.isComposing || e.keyCode === 229) return; // 한글 조합 중에는 검색창이 처리한다
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (qFiltered.length === 0) return;
      qIndex = (qIndex + (e.key === 'ArrowDown' ? 1 : -1) + qFiltered.length) % qFiltered.length;
      renderQuick();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (qFiltered[qIndex]) chooseQuick(qFiltered[qIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePops();
      const c = sel.composer(); if (c) c.focus();
    }
  }

  function chooseQuick(item) {
    closePops();
    // 전송하지 않는다. 커서 위치에 넣고 입력창에 포커스를 돌려준다.
    insertText(item.text, { replaceAll: false }).then(function (ok) {
      const c = sel.composer(); if (c) c.focus();
      if (!ok) util.toast('입력창에 넣지 못했습니다. 입력창을 한 번 클릭한 뒤 다시 시도하세요');
    });
  }

  // 막대 위치와 표시 상태. 입력창 위에 붙인다.
  function render() {
    if (!ui) return;
    const c = sel.composer();
    const r = c ? c.getBoundingClientRect() : null;
    const s = util.settings() || {};
    const visible = !!(r && r.width > 0 && r.height > 0 && currentThread() && !sel.dialogOpen());
    if (!visible) { ui.bar.style.display = 'none'; ui.outline.style.display = 'none'; closePops(); return; }
    ui.bar.style.display = 'flex';
    ui.bar.style.left = Math.max(4, r.left) + 'px';
    ui.bar.style.bottom = Math.max(0, window.innerHeight - r.top + 6) + 'px';
    ui.quickBtn.style.display = s.quickRepliesEnabled === false ? 'none' : '';
    const cur = currentLang();
    ui.langBtn.textContent = '번역: ' + (cur === null ? '…' : cur === 'OFF' ? '끔' : cur) + ' ▾';
    ui.langBtn.disabled = cur === null;
    const active = s.sendTranslateEnabled !== false && cur !== null && cur !== 'OFF';
    if (active) {
      ui.outline.style.display = 'block';
      ui.outline.style.left = (r.left - 2) + 'px'; ui.outline.style.top = (r.top - 2) + 'px';
      ui.outline.style.width = (r.width + 4) + 'px'; ui.outline.style.height = (r.height + 4) + 'px';
    } else ui.outline.style.display = 'none';
  }

  function schedule() {
    if (rafPending) return;
    rafPending = true;
    const run = function () { rafPending = false; render(); };
    if (document.hidden) setTimeout(run, 50); else requestAnimationFrame(run);
  }

  function tick() {
    // 대화 전환 감지(주소 변화 콜백보다 먼저일 수 있다). 대화가 바뀌면 언어를 다시 불러온다.
    const tid = currentThread();
    if (tid !== loadingThread) { closePops(); loadLang(); }
    const c = sel.composer();
    if (c !== observed) {
      observed = c;
      if (ro) ro.disconnect();
      if (c && typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(schedule); ro.observe(c); }
    }
    render();
  }

  function init() {
    trackSelection();
    build();
    util.onMessage('SETTINGS_CHANGED', function (msg) {
      if (msg && msg.quickRepliesChanged) quickDirty = true;
      render();
    });
    util.onInboxChange(function () { tick(); });
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    setInterval(tick, TICK_MS);
    tick();
  }

  root.composer = {
    insertText: insertText,
    currentLang: currentLang,
    text: text,
    // Task 13(전송 가로채기)이 같은 규칙으로 쓰는 도구
    _normalize: normalize,
    _selectAll: selectAll
  };

  if (typeof document !== 'undefined' && root.sel && root.util) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }
})(self.MBX = self.MBX || {});
