// 입력창 주변 UI(막대, 언어 버튼, 빠른 메시지 창), 입력창 내용 넣기, R5 전송 가로채기(기획서 8장).
// fetch와 chrome.storage는 쓰지 않는다. 입력창 내용은 paste 이벤트나 execCommand로만 바꾸고 DOM을 직접 고치지 않는다.
// 로그는 console.debug만, 본문은 넣지 않는다.
(function (root) {
  const sel = root.sel;
  const util = root.util;
  const INSERT_VERIFY_MS = 500;
  const POLL_MS = 50;
  const TICK_MS = 300;

  const LANGS = root.SEND_LANGS;

  // ================= 입력창 접근 =================
  // 비교 정규화는 lib/sendgate.js의 normalizeForCompare 하나만 쓴다(호출 시점에 찾는다: node 테스트에서는 나중에 붙는다).
  function normalize(s) {
    return root.normalizeForCompare(s);
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

  // 500ms 안에 입력창에 반영됐는지 본다. before0 는 넣기 전에 한 번만 잡은 값이다.
  function isReflected(replaceAll, before0, now, want) {
    if (replaceAll) return now === want;
    return now !== before0 && now.indexOf(want) >= 0;
  }

  // 다음 방법을 쓰기 전의 판단. 앞 방법이 늦게 반영됐다면 'done'(두 번 넣지 않는다), 아니면 'next'.
  function decideFallback(replaceAll, before0, now, want) {
    return isReflected(replaceAll, before0, now, want) ? 'done' : 'next';
  }

  function waitReflected(replaceAll, before0, want) {
    return new Promise(function (resolve) {
      const t0 = Date.now();
      const check = function () {
        if (isReflected(replaceAll, before0, normalize(text()), want)) { resolve(true); return; }
        if (Date.now() - t0 >= INSERT_VERIFY_MS) { resolve(false); return; }
        setTimeout(check, POLL_MS);
      };
      check();
    });
  }

  // 1순위 합성 붙여넣기, 2순위 execCommand('insertText'). U6 미확인 상태이므로 결과를 반드시 확인해 돌려준다.
  // replaceAll: 전체 선택 → 한 프레임 대기(8-5 교체 2번) → 넣기. 아니면 현재 커서 위치에 넣는다.
  // opts.abort: 넣기 직전마다 확인하는 중단 조건(R5: 대화가 바뀌었는지). 참이면 넣지 않고 false.
  async function insertText(t, opts) {
    const el = sel.composer();
    if (!el || typeof t !== 'string' || t.trim() === '') return false;
    const replaceAll = !!(opts && opts.replaceAll);
    const aborted = function () { return !!(opts && typeof opts.abort === 'function' && opts.abort()); };
    const want = normalize(t);
    const before0 = normalize(text());
    const methods = [pasteText, execInsert];
    for (let i = 0; i < methods.length; i++) {
      if (sel.composer() !== el || aborted()) return false; // 도중에 입력창이 바뀌었거나 중단
      // 앞 방법이 500ms 뒤에 반영됐을 수 있다. 그 위에 다시 넣지 않는다.
      if (i > 0 && decideFallback(replaceAll, before0, normalize(text()), want) === 'done') return true;
      el.focus();
      if (replaceAll) { selectAll(el); await nextFrame(); } else { restoreCaret(el); }
      if (sel.composer() !== el || aborted()) return false; // 프레임 대기 중에 대화가 바뀜: 넣지 않는다
      methods[i](el, t);
      if (await waitReflected(replaceAll, before0, want)) return true;
    }
    return false;
  }

  // ================= 대화별 언어 =================
  let lang = null;       // { lang: 언어 코드, on: 불리언 } | null(불러오는 중). UI 수정 기획서 4-4
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
        if (res && typeof res.lang === 'string' && typeof res.on === 'boolean' && res.threadId === tid &&
            currentThread() === tid && langThread !== tid) {
          lang = { lang: res.lang, on: res.on }; langThread = tid; render();
        }
      });
      retryTimer = setTimeout(attempt, root.THREAD_LANG_RETRY_MS || 500);
    };
    attempt();
  }

  // 언어와 켬/끔을 저장 요청 한 번에 함께 보낸다. 언어를 고르면 꺼져 있어도 켠다(4-4).
  function setThreadState(code, on) {
    const tid = currentThread();
    if (!tid || currentLang() === null) return; // 불러오는 중에는 바꾸지 않는다
    lang = { lang: code, on: on }; langThread = tid;
    render();
    util.send('SET_THREAD_LANG', { threadId: tid, lang: code, on: on }).then(function (res) {
      if (!res || res.ok !== true) notify('언어 설정을 저장하지 못했습니다', 'error');
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

  // ================= R5: 한글 입력을 번역해 전송 (기획서 8장) =================
  // 원칙: 실패하면 전송하지 않는다. 판단은 lib/sendgate.js(decideSend 등)에 있고 여기서는 이벤트와 흐름만 다룬다.
  // sendgate 함수는 호출 시점에 root에서 찾는다(node 테스트에서는 composer.js보다 나중에 붙는다).
  const MSG_LOADING = '번역 설정을 불러오는 중입니다. 잠시 후 다시 시도하세요';
  const MSG_RELOAD = '확장 프로그램이 갱신되었습니다. 페이지를 새로고침하세요';
  const MSG_LEFTOVER = '번역 결과에 한글이 남아 있습니다. 확인 후 Enter를 한 번 더 누르면 그대로 전송됩니다';
  const MSG_MANUAL = '번역되었습니다. Enter를 한 번 더 눌러 전송하세요';
  const MSG_THREAD = '대화가 바뀌어 번역 전송을 중단했습니다. 전송하지 않았습니다';
  const MSG_EDITED = '번역 중 입력 내용이 바뀌어 중단했습니다. 전송하지 않았습니다';
  const MSG_REPLACE = '입력창 내용을 번역문으로 바꾸지 못해 전송하지 않았습니다';
  const MSG_REPLACE_RESTORE = '입력창 내용을 번역문으로 바꾸지 못해 전송하지 않았습니다. 원문을 다시 넣지 못했으니 입력창을 확인하세요';
  const MSG_WRONG_THREAD = '번역 중 대화가 바뀌어 번역문이 지금 입력창에 들어갔을 수 있습니다. 전송하지 않았습니다. 입력창을 확인하고 지운 뒤 다시 입력하세요';
  const MSG_NO_THREAD = '대화를 확인할 수 없어 번역 전송을 막았습니다. 대화를 다시 열어 주세요';
  const MSG_NO_COMPOSER = '입력창을 찾지 못해 번역 전송이 동작하지 않습니다. 화면 구조가 바뀌었을 수 있습니다';
  const MSG_BLOCKED_SCREEN = '로그인/보안 확인 화면이 떠 있어 번역 전송을 멈췄습니다. 전송하지 않았습니다';
  const MSG_NO_TOOLBAR = "번역 도구 막대를 표시하지 못해 한글 메시지 전송을 막았습니다. 새로고침해도 같으면 설정에서 '한글 입력을 번역해 전송'을 끄세요";
  const SENT_SHOW_MS = 5000;
  const NO_COMPOSER_NOTICE_MS = 5000;

  function C(name, dflt) { return typeof root[name] === 'number' ? root[name] : dflt; }

  let busy = false;          // 번역 처리 중(8-2의 4번). 이 동안의 Enter·전송 버튼은 삼킨다
  let flowSeq = 0;           // 흐름 번호. 대화가 바뀌면 올려서 늦게 온 응답을 버린다
  let bypassUntil = 0;       // 확장이 이어서 실행한 전송의 통과 표시(8-5)
  let bypassText = null;     // 통과 표시는 입력창이 이 번역문(한글 없음)일 때만 유효하다
  let lastTranslated = null; // 직전 번역 결과(정규화). 8-2의 6번
  let lastTranslatedThread = null;
  let pending = null;        // 조합 중 Enter 뒤의 "전송 대기" { until, thread, el, timer }
  let localSettings = null;  // util.settings()가 아직 없을 때 GET_PUBLIC_SETTINGS로 받은 값
  let quarantineText = null; // 대화 전환 중에 들어갔을 수 있는 번역문(정규화). 입력창이 이 내용이면 전송을 막는다
  let inflightTranslation = null; // 지금 입력창에 넣고 있는 번역문(정규화). 넣기가 끝나면 null
  let noComposerSince = 0;   // 대화 화면인데 입력창을 못 찾은 시각
  let noComposerNotified = null; // 안내한 대화 번호(대화마다 1회)
  let toolbarMissing = false; // 대화 화면인데 5초 넘게 도구 막대를 넣지 못함(4-2). 막대가 들어가면 즉시 풀린다

  // 확장 컨텍스트가 살아 있는지. port는 service worker 재시작 동안 잠깐 없을 수 있으나 TRANSLATE는 sendMessage로 깨운다.
  function extAlive() {
    if (!util) return false;
    return typeof util.alive === 'function' ? !!util.alive() : !!util.connected();
  }

  function quarantined() {
    return quarantineText !== null && normalize(text()) === quarantineText;
  }

  function curSettings() { return (util && util.settings()) || localSettings; }

  // 수신함 경로가 아니거나 번역 전송이 꺼져 있으면(설정을 받은 뒤에만 판단) 리스너는 바로 돌아간다.
  function guardActive() {
    if (typeof location === 'undefined' || sel.channelFromPath(location.pathname) === null) return false;
    const s = curSettings();
    return !(s && s.sendTranslateEnabled === false);
  }

  function inComposer(target) {
    const c = sel.composer();
    if (!c || !target) return false;
    const n = target.nodeType === 3 ? target.parentElement : target;
    return !!n && (n === c || c.contains(n));
  }

  function bypassActive() {
    return bypassText !== null && Date.now() < bypassUntil && normalize(text()) === bypassText;
  }

  function buildCtx() {
    const s = curSettings();
    const l = currentLang();
    const tid = currentThread();
    return {
      text: normalize(text()),
      bypass: bypassActive(),
      busy: busy,
      connected: extAlive(),
      settingsLoaded: !!s,
      langLoaded: l !== null,
      enabled: !!s && s.sendTranslateEnabled !== false,
      lang: l ? l.lang : null,
      on: l ? l.on : undefined,
      toolbar: !toolbarMissing,
      lastTranslated: (lastTranslated !== null && lastTranslatedThread === tid) ? lastTranslated : null
    };
  }

  // 금지 사항 9: 로그인·보안 확인·캡차 화면이면 참.
  function blockedNow() {
    return typeof sel.blockedScreen === 'function' && !!sel.blockedScreen();
  }

  // decideSend 앞에 "대화 전환 중 들어간 번역문" 격리를 더한다. 격리된 내용은 어느 대화에서도 Meta에 넘기지 않는다.
  // 금지 사항 9: 로그인·보안 확인 화면에서는 번역 흐름을 시작하지 않는다. 그때 Meta에 넘기지 않을 입력(한글 등)은
  // 그대로 막는다('block_screen'). 사용자가 고른 통과(한글 없음, 번역 끔, 이 대화 끔)는 그대로 둔다.
  function decide(ctx) {
    if (!ctx.bypass && !ctx.busy && quarantined()) return 'quarantine';
    const d = root.decideSend(ctx);
    if (d !== 'pass' && blockedNow()) return 'block_screen';
    return d;
  }

  function block(e, prevent) {
    if (prevent) e.preventDefault();
    e.stopImmediatePropagation();
  }

  function reloadSettings() {
    util.send('GET_PUBLIC_SETTINGS').then(function (res) {
      if (res && typeof res === 'object' && res.ok !== false && typeof res.sendTranslateEnabled === 'boolean') {
        localSettings = res; render();
      }
    });
  }

  // 막은 뒤의 처리. 흐름과 안내는 keydown·click에서만 시작한다(keypress, keyup, mousedown, pointerdown은 막기만).
  function act(d) {
    if (d === 'intercept') { runFlow(false); return; }
    if (d === 'block_loading') {
      // 연결이 끊겼으면 "불러오는 중"은 영원히 끝나지 않는다: 새로고침 안내를 띄운다(Review Focus 1).
      if (!extAlive()) { notify(MSG_RELOAD, 'error'); return; }
      // 설정은 있는데 대화 번호(selected_item_id)가 없으면 언어를 불러올 수 없다.
      if (curSettings() && !currentThread()) { notify(MSG_NO_THREAD, 'error'); return; }
      notify(MSG_LOADING, 'info');
      if (!util.settings()) reloadSettings();
      loadLang();
      return;
    }
    if (d === 'block_no_toolbar') util.toast(MSG_NO_TOOLBAR); // 막대가 없으므로 토스트로 알린다
    if (d === 'block_disconnected') notify(MSG_RELOAD, 'error');
    if (d === 'block_screen') notify(MSG_BLOCKED_SCREEN, 'error'); // 로그인·보안 확인 화면이면 notify 가 토스트로 보낸다
    if (d === 'quarantine') notify(MSG_WRONG_THREAD, 'error');
    // 'swallow': 번역 처리 중에 다시 누른 것. 아무것도 하지 않는다.
  }

  // ---- 조합 중 Enter의 "전송 대기" (8-3) ----
  function armPending() {
    clearPending();
    const p = { until: Date.now() + C('SEND_PENDING_MS', 500), thread: currentThread(), el: sel.composer(), timer: null };
    p.timer = setTimeout(function () { if (pending === p) pending = null; }, C('SEND_PENDING_MS', 500));
    pending = p;
  }
  function clearPending() {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  }
  function pendingActive() {
    if (!pending) return false;
    if (Date.now() >= pending.until || pending.thread !== currentThread() || pending.el !== sel.composer()) { clearPending(); return false; }
    return true;
  }

  // 포커스된 전송 버튼의 키보드 실행(Enter, Space). 버튼 클릭과 같은 판단을 거친다(최종 검토 3번).
  // 수정 키는 보지 않는다(Shift+Enter 로도 버튼이 실행될 수 있다). 흐름과 안내는 keydown 에서만 시작한다.
  function onSubmitKey(e) {
    const d = decide(buildCtx());
    if (d === 'pass') return;
    block(e, true);
    if (e.type === 'keydown') act(d);
  }

  function onKeyEvent(e) {
    try {
      if (!guardActive()) return;
      if (root.isActivationKey(e) && sel.isSubmitButton(e.target)) { onSubmitKey(e); return; }
      if (!root.isEnterKey(e) || root.hasModifier(e)) return;
      if (!inComposer(e.target)) return;
      const ctx = buildCtx();
      if (e.type !== 'keydown') {
        // keypress, keyup: 처리 중·전송 대기 중이거나 가로챌 상황이면 막기만 한다.
        if (ctx.bypass) return;
        if (busy || pendingActive() || decide(ctx) !== 'pass') block(e, true);
        return;
      }
      if (root.isComposingEvent(e)) {
        // 조합 중 Enter: preventDefault는 하지 않는다(입력기가 글자를 확정해야 한다).
        if (ctx.bypass) return;
        if (busy) { e.stopImmediatePropagation(); return; }
        const d = decide(ctx);
        if (d === 'pass') return; // 번역 끔 등: Meta의 원래 동작에 맡긴다
        e.stopImmediatePropagation();
        if (d === 'intercept') armPending();
        else act(d);
        return;
      }
      if (pendingActive()) {
        // 조합 종료 후 뒤따르는 조합 아님 Enter가 compositionend보다 먼저 왔다. 한 프레임 뒤에 1회 시작한다.
        clearPending();
        const d0 = decide(ctx);
        if (d0 === 'pass') return;
        block(e, true);
        if (d0 === 'intercept') runFlow(true); else act(d0);
        return;
      }
      const d = decide(ctx);
      if (d === 'pass') return;
      block(e, true);
      act(d);
    } catch (err) {
      console.debug('send gate key error');
      failSafe(e);
    }
  }

  function onPointerEvent(e) {
    try {
      if (!guardActive()) return;
      if (!sel.isSubmitButton(e.target)) return;
      const d = decide(buildCtx());
      if (d === 'pass') return;
      block(e, true);
      if (e.type === 'click') act(d);
    } catch (err) {
      console.debug('send gate click error');
      failSafe(e);
    }
  }

  // 판단 중 예외가 나면 한글이 있는 입력은 Meta에 넘기지 않는다.
  function failSafe(e) {
    try {
      const hh = typeof root.hasHangul === 'function' ? root.hasHangul(text()) : /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(text());
      if (hh && !bypassActive()) block(e, true);
    } catch (e2) { /* 무시 */ }
  }

  function onCompositionEnd(e) {
    try {
      if (!pendingActive() || !inComposer(e.target)) return;
      clearPending();
      runFlow(true); // compositionend 직후에는 Lexical이 아직 반영하지 않았을 수 있다: 한 프레임 기다린다
    } catch (err) { console.debug('send gate composition error'); }
  }

  function onFocusOut(e) {
    if (pending && inComposer(e.target)) clearPending();
  }

  function withTimeout(p, ms) {
    return new Promise(function (resolve) {
      const t = setTimeout(function () { resolve({ ok: false, code: 'TIMEOUT', message: '번역 시간이 초과되었습니다' }); }, ms);
      p.then(function (r) { clearTimeout(t); resolve(r); }, function () { clearTimeout(t); resolve({ ok: false, code: 'INTERNAL' }); });
    });
  }

  function failText(res) {
    if (res && res.code === 'DISCONNECTED') return MSG_RELOAD;
    const why = (res && typeof res.message === 'string' && res.message) ? res.message : '잠시 후 다시 시도하세요';
    return '번역하지 못해 전송하지 않았습니다. ' + why;
  }

  // 번역 흐름(8-1). busy는 시작과 동시에 켠다(compositionend와 뒤따르는 Enter가 함께 와도 1회만 실행).
  async function runFlow(waitFrame) {
    if (busy) return;
    busy = true;
    const my = ++flowSeq;
    const tid = currentThread();
    const c = sel.composer();
    render();
    try {
      if (waitFrame) await nextFrame();
      if (my !== flowSeq || !c || currentThread() !== tid || sel.composer() !== c) return;
      const ctx = buildCtx();
      ctx.busy = false;
      const d = decide(ctx);
      if (d !== 'intercept') { if (d !== 'pass') act(d); return; } // 'pass'면 전송하지 않고 그대로 둔다
      const original = text();
      const originalNorm = normalize(original);
      const res = await withTimeout(
        util.send('TRANSLATE', { text: original, targetLang: ctx.lang, purpose: 'send' }),
        C('DEEPL_TIMEOUT_MS', 10000) + 2000);
      if (my !== flowSeq) return;
      if (currentThread() !== tid) { notify(MSG_THREAD, 'error'); return; }
      if (sel.composer() !== c || normalize(text()) !== originalNorm) { notify(MSG_EDITED, 'error'); return; }
      if (!res || res.ok !== true || typeof res.text !== 'string' || normalize(res.text) === '') { notify(failText(res), 'error'); return; }
      const translated = res.text;
      const want = normalize(translated);
      if (blockedNow()) { notify(MSG_BLOCKED_SCREEN, 'error'); return; } // 금지 사항 9: 번역 중에 로그인·보안 확인 화면이 떴다
      const stale = function () { return my !== flowSeq || currentThread() !== tid; };
      // 넣는 동안 대화가 바뀌면 onThreadChanged가 이 번역문을 바로 격리한다(넣기가 끝나기 전의 틈을 막는다).
      inflightTranslation = want;
      let ok;
      try { ok = await insertText(translated, { replaceAll: true, abort: stale }); } finally { inflightTranslation = null; }
      if (stale()) {
        // 넣는 도중 대화가 바뀌었다. Meta가 같은 입력창을 다시 쓰면 번역문이 다른 대화의 입력창에 있을 수 있다.
        // 그 내용은 격리해 다음 Enter·전송 버튼에서도 Meta에 넘기지 않는다(입력창을 고치거나 비우면 풀린다).
        if (sel.composer() && normalize(text()) === want) { quarantineText = want; notify(MSG_WRONG_THREAD, 'error'); }
        else if (my === flowSeq) notify(MSG_THREAD, 'error');
        return;
      }
      if (!ok || sel.composer() !== c || normalize(text()) !== want) {
        // 교체 실패: 전송하지 않는다. 가능하면 원문을 복원한다.
        let restored = sel.composer() === c && normalize(text()) === originalNorm;
        if (!restored && sel.composer() === c) restored = await insertText(original, { replaceAll: true, abort: stale });
        notify(restored ? MSG_REPLACE : MSG_REPLACE_RESTORE, 'error');
        return;
      }
      lastTranslated = want; lastTranslatedThread = tid;
      if (root.hasHangul(translated)) { notify(MSG_LEFTOVER, 'info'); return; }
      await continueSend(my, tid, c, want, original);
    } catch (err) {
      console.debug('send translate flow failed');
    } finally {
      if (my === flowSeq) { busy = false; render(); }
    }
  }

  // 전송 이어가기(8-5, U7 미확인). 버튼 click(), 버튼이 없을 때만 합성 Enter. 1.5초 안에 비면 성공.
  async function continueSend(my, tid, c, want, original) {
    if (currentThread() !== tid || sel.composer() !== c || normalize(text()) !== want || root.hasHangul(text())) {
      notify(MSG_EDITED, 'error'); return;
    }
    if (blockedNow()) { notify(MSG_BLOCKED_SCREEN, 'error'); return; } // 금지 사항 9: 이어서 전송하지 않는다
    bypassText = want;
    bypassUntil = Date.now() + C('BYPASS_MS', 1000);
    try {
      const btn = sel.submitButton();
      if (btn) btn.click();
      else c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    } catch (err) { console.debug('continue send failed'); }
    const sent = await waitEmpty(tid, C('SEND_CONFIRM_MS', 1500));
    bypassUntil = 0; bypassText = null;
    if (my !== flowSeq) return;
    if (sent) {
      lastTranslated = null; lastTranslatedThread = null;
      showSentOriginal(original);
    } else {
      notify(MSG_MANUAL, 'info'); // 번역문에는 한글이 없으므로 다음 Enter는 그대로 전송된다
    }
  }

  function waitEmpty(tid, ms) {
    return new Promise(function (resolve) {
      const t0 = Date.now();
      const check = function () {
        if (sel.composer() && currentThread() === tid && text() === '') { resolve(true); return; }
        if (Date.now() - t0 >= ms) { resolve(false); return; }
        setTimeout(check, POLL_MS);
      };
      setTimeout(check, POLL_MS);
    });
  }

  // 전송 직후 한글 원문을 막대 바로 위에 5초간 보여 준다(4-5). 저장하지 않는다.
  function showSentOriginal(original) {
    notify('보낸 원문: ' + String(original).replace(/\s+/g, ' ').trim(), 'sent');
  }

  // 대화가 바뀌면 처리 중인 흐름을 즉시 중단하고 기록을 지운다.
  function onThreadChanged() {
    clearPending();
    lastTranslated = null; lastTranslatedThread = null;
    bypassUntil = 0; bypassText = null;
    if (inflightTranslation !== null) quarantineText = inflightTranslation; // 붙여넣기가 늦게 반영돼도 새 대화에서 넘기지 않는다
    hideAux();
    if (busy) { flowSeq++; busy = false; notify(MSG_THREAD, 'error'); }
  }

  // 대화 화면인데 입력창 선택자가 5초 넘게 맞지 않으면 대화마다 1회 알린다(가로채기가 조용히 꺼지지 않게).
  function checkComposerPresent(tid) {
    if (!tid || !guardActive() || sel.composer()) { noComposerSince = 0; return; }
    const now = Date.now();
    if (!noComposerSince) { noComposerSince = now; return; }
    if (now - noComposerSince >= NO_COMPOSER_NOTICE_MS && noComposerNotified !== tid) {
      noComposerNotified = tid;
      util.toast(MSG_NO_COMPOSER);
    }
  }

  function registerSendGate() {
    ['keydown', 'keypress', 'keyup'].forEach(function (t) { window.addEventListener(t, onKeyEvent, true); });
    ['click', 'mousedown', 'pointerdown'].forEach(function (t) { window.addEventListener(t, onPointerEvent, true); });
    window.addEventListener('compositionend', onCompositionEnd, true);
    window.addEventListener('focusout', onFocusOut, true);
  }

  // ================= UI: 입력창 위 도구 막대(UI 수정 기획서 4장)와 빠른 메시지 목록 창(5장) =================
  // 막대는 대화 패널의 flex 컨테이너 안, 입력창 영역 바로 앞에 [data-mbx="toolbar"] 요소 1개로 넣는다. 안쪽은 Shadow DOM 이다.
  // 겹쳐 뜨는 창(빠른 메시지, 언어 목록)은 막대 안에서 position: absolute 로 띄운다. 조상의 overflow 에 잘리면
  // 두 창만 body 아래의 mbx-root 로 옮겨 position: fixed 로 띄운다(5장, 9장 V9).
  const NO_TOOLBAR_MS = 5000;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICON_BOLT = 'M9 1.5 3 9h4.5L7 14.5 13 7H8.5L9 1.5Z';
  const ICON_CHEVRON = 'm3 4.5 3 3 3-3';
  const ICON_SEARCH = ['M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Z', 'm10.5 10.5 3 3'];
  const ICON_CHECK = 'm3 7.5 2.5 2.5L11 4.5';
  const ICON_CLOSE = 'M3 3l6 6M9 3l-6 6';

  const POP_CSS =
    '.mbx-pop{position:absolute;bottom:calc(100% + 4px);z-index:5;background:#fff;border:1px solid #E4E6EB;border-radius:12px;' +
    'box-shadow:0 4px 16px rgba(0,0,0,.15);overflow:hidden;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#1C1E21;' +
    'box-sizing:border-box;text-align:left}' +
    '.mbx-pop[hidden]{display:none}' +
    '.mbx-pop.mbx-fixed{position:fixed}' +
    '.mbx-qpop{left:12px;width:min(360px,calc(100% - 24px))}' +
    '.mbx-qsearch{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #E4E6EB}' +
    '.mbx-qsearch[hidden]{display:none}' +
    '.mbx-qsearch svg{width:16px;height:16px;color:#65676B;flex:none}' +
    '.mbx-qsearch input{all:unset;flex:1;min-width:0;font-size:14px;color:#1C1E21;caret-color:#1877F2}' +
    '.mbx-qsearch input::placeholder{color:#65676B}' +
    '.mbx-qlist{max-height:320px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#CED0D4 transparent}' +
    '.mbx-qi{padding:10px 12px;cursor:pointer;border-bottom:1px solid #E4E6EB}.mbx-qi:last-child{border-bottom:0}' +
    '.mbx-qi[aria-selected="true"]{background:#F0F2F5}' +
    '.mbx-qr1{display:flex;align-items:center;gap:8px}' +
    '.mbx-qt{font-size:14px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.mbx-tag{font-size:11px;background:#F0F2F5;color:#65676B;border-radius:999px;padding:2px 8px;flex:none;white-space:nowrap}' +
    '.mbx-qi[aria-selected="true"] .mbx-tag{background:#fff}' +
    '.mbx-qb{margin-top:3px;font-size:13px;line-height:1.4;color:#65676B;display:-webkit-box;-webkit-line-clamp:2;' +
    '-webkit-box-orient:vertical;overflow:hidden;white-space:normal;overflow-wrap:anywhere}' +
    '.mbx-qempty{padding:22px 12px;text-align:center;color:#65676B;font-size:13px}' +
    '.mbx-qempty button{margin-top:10px}' +
    '.mbx-qfoot{border-top:1px solid #E4E6EB;padding:6px 8px;display:flex;justify-content:flex-end}' +
    '.mbx-qfoot[hidden]{display:none}' +
    '.mbx-link{all:unset;font-size:12px;color:#1877F2;cursor:pointer;padding:4px 6px;border-radius:4px}' +
    '.mbx-link:hover{text-decoration:underline;text-underline-offset:2px}' +
    '.mbx-link:focus-visible{outline:2px solid #1877F2}' +
    '.mbx-pill{all:unset;font-size:12px;font-weight:500;height:24px;line-height:24px;padding:0 10px;border-radius:999px;' +
    'background:#E4E6EB;color:#1C1E21;cursor:pointer}.mbx-pill:hover{background:#D8DADF}' +
    '.mbx-pill:focus-visible{outline:2px solid #1877F2;outline-offset:1px}' +
    '.mbx-lpop{right:12px;width:220px}' +
    '.mbx-lpop ul{list-style:none;margin:0;padding:4px;max-height:280px;overflow-y:auto;outline:none;scrollbar-width:thin}' +
    '.mbx-lpop li{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;font-size:13px;cursor:pointer}' +
    '.mbx-lpop li[aria-selected="true"]{background:#F0F2F5}' +
    '.mbx-lpop li .mbx-cd{margin-left:auto;color:#65676B;font-size:11px;letter-spacing:.02em}' +
    '.mbx-lpop li svg{width:14px;height:14px;color:#1877F2;flex:none;visibility:hidden}' +
    '.mbx-lpop li.mbx-cur{font-weight:600}.mbx-lpop li.mbx-cur svg{visibility:visible}';

  const BAR_CSS =
    ':host{all:initial;display:block;position:relative;flex:none;align-self:stretch;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;' +
    'color:#1C1E21;container-type:inline-size;container-name:mbxbar}' +
    '.mbx-bar{box-sizing:border-box;height:36px;padding:0 12px;border-top:1px solid #E4E6EB;background:#fff;display:flex;' +
    'align-items:center;justify-content:space-between;gap:8px}' +
    '.mbx-quick{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:5px;font-size:13px;color:#1C1E21;' +
    'padding:6px 8px;margin-left:-8px;border-radius:6px;cursor:pointer;white-space:nowrap}' +
    '.mbx-quick[hidden]{display:none}.mbx-quick svg{width:16px;height:16px;flex:none}' +
    '.mbx-quick:hover{background:#F0F2F5}.mbx-quick[aria-expanded="true"]{background:#E7F3FF;color:#1877F2}' +
    '.mbx-quick:focus-visible,.mbx-langbtn:focus-visible,.mbx-sw:focus-visible{outline:2px solid #1877F2;outline-offset:1px}' +
    '@container mbxbar (max-width: 300px){.mbx-qlbl{display:none}}' +
    '.mbx-tctl{display:flex;align-items:center;gap:8px;min-width:0;margin-left:auto}.mbx-tctl[hidden]{display:none}' +
    '.mbx-state{font-size:12px;white-space:nowrap;color:#65676B}' +
    '.mbx-state.mbx-on{color:#1877F2;font-weight:600}.mbx-state.mbx-busy{color:#1877F2}' +
    '.mbx-div{width:1px;height:14px;background:#E4E6EB;flex:none}' +
    '.mbx-langbtn{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:3px;font-size:12px;color:#1C1E21;' +
    'padding:4px 6px;border-radius:6px;cursor:pointer;min-width:0}' +
    '.mbx-langbtn span{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.mbx-langbtn svg{width:12px;height:12px;flex:none}.mbx-langbtn:hover{background:#F0F2F5}' +
    '.mbx-langbtn.mbx-off{color:#8A8D91}.mbx-langbtn:disabled{cursor:default;background:transparent}' +
    '.mbx-sw{all:unset;box-sizing:border-box;position:relative;width:32px;height:18px;border-radius:999px;background:#CED0D4;' +
    'cursor:pointer;flex:none;transition:background-color .16s ease-out}' +
    '.mbx-sw::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;' +
    'box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .18s cubic-bezier(.2,.8,.2,1)}' +
    '.mbx-sw[aria-checked="true"]{background:#1877F2}.mbx-sw[aria-checked="true"]::after{transform:translateX(14px)}' +
    '.mbx-sw:disabled{opacity:.5;cursor:default}' +
    '.mbx-aux{position:absolute;left:0;right:0;bottom:100%;box-sizing:border-box;height:26px;padding:0 8px 0 12px;background:#fff;' +
    'border-top:1px solid #E4E6EB;display:flex;align-items:center;gap:8px;font-size:12px;color:#65676B}' +
    '.mbx-aux[hidden]{display:none}.mbx-aux.mbx-err{color:#B3261E}' +
    '.mbx-auxtext{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.mbx-auxx{all:unset;display:grid;place-items:center;width:20px;height:20px;border-radius:4px;color:#65676B;cursor:pointer}' +
    '.mbx-auxx:hover{background:#F0F2F5}.mbx-auxx:focus-visible{outline:2px solid #1877F2}.mbx-auxx svg{width:12px;height:12px}' +
    POP_CSS;

  let bar = null;            // 막대 요소들. 한 번 만들고 다시 넣을 때 그대로 쓴다
  let toolbarSince = 0;      // 대화 화면인데 막대를 넣지 못한 시각
  let insertBlocked = false; // 테스트용: 막대 넣기 실패를 흉내 낸다
  let auxTimer = null;
  let auxKind = null;        // 'error' | 'info' | 'sent' | null
  let rootStyled = false;
  let qIndex = 0;
  let qFiltered = [];
  let lIndex = 0;

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt !== undefined) e.textContent = txt;
    return e;
  }

  function svg(paths, viewBox, opts) {
    const s = document.createElementNS ? document.createElementNS(SVG_NS, 'svg') : document.createElement('svg');
    s.setAttribute('viewBox', viewBox);
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', (opts && opts.w) || '1.5');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    [].concat(paths).forEach(function (d) {
      const p = document.createElementNS ? document.createElementNS(SVG_NS, 'path') : document.createElement('path');
      p.setAttribute('d', d);
      s.appendChild(p);
    });
    return s;
  }

  // 버튼의 mousedown 에서 기본 동작을 막아 입력창의 포커스와 커서를 유지한다(2장 10번). 검색란은 막지 않는다.
  function keepFocus(b) { b.addEventListener('mousedown', function (e) { e.preventDefault(); }); return b; }

  function build() {
    const host = document.createElement('div');
    host.setAttribute('data-mbx', 'toolbar');
    root.inject.shieldEvents(host);
    const sh = host.attachShadow({ mode: 'open' });
    const style = el('style'); style.textContent = BAR_CSS; sh.appendChild(style);

    const aux = el('div', 'mbx-aux'); aux.setAttribute('data-part', 'aux'); aux.setAttribute('role', 'status'); aux.hidden = true;
    const auxText = el('span', 'mbx-auxtext'); auxText.setAttribute('data-part', 'auxtext');
    const auxX = keepFocus(el('button', 'mbx-auxx')); auxX.type = 'button'; auxX.setAttribute('aria-label', '닫기');
    auxX.appendChild(svg(ICON_CLOSE, '0 0 12 12', { w: '1.6' }));
    auxX.addEventListener('click', hideAux);
    aux.appendChild(auxText); aux.appendChild(auxX);

    const row = el('div', 'mbx-bar');
    const quickBtn = keepFocus(el('button', 'mbx-quick'));
    quickBtn.type = 'button'; quickBtn.setAttribute('data-part', 'quick');
    quickBtn.setAttribute('aria-label', '빠른 메시지'); quickBtn.setAttribute('aria-haspopup', 'listbox'); quickBtn.setAttribute('aria-expanded', 'false');
    quickBtn.appendChild(svg(ICON_BOLT, '0 0 16 16'));
    quickBtn.appendChild(el('span', 'mbx-qlbl', '빠른 메시지'));
    quickBtn.addEventListener('click', toggleQuick);

    const tctl = el('div', 'mbx-tctl'); tctl.setAttribute('data-part', 'tctl');
    const state = el('span', 'mbx-state'); state.setAttribute('data-part', 'state');
    const div = el('span', 'mbx-div'); div.setAttribute('aria-hidden', 'true');
    const langBtn = keepFocus(el('button', 'mbx-langbtn'));
    langBtn.type = 'button'; langBtn.setAttribute('data-part', 'lang'); langBtn.setAttribute('aria-haspopup', 'listbox'); langBtn.setAttribute('aria-expanded', 'false');
    const langName = el('span'); langName.setAttribute('data-part', 'langname');
    langBtn.appendChild(langName); langBtn.appendChild(svg(ICON_CHEVRON, '0 0 12 12'));
    langBtn.addEventListener('click', toggleLangMenu);
    const sw = keepFocus(el('button', 'mbx-sw'));
    sw.type = 'button'; sw.setAttribute('role', 'switch'); sw.setAttribute('aria-label', '이 대화에서 한글 입력을 번역해 전송');
    sw.addEventListener('click', onSwitch);
    tctl.appendChild(state); tctl.appendChild(div); tctl.appendChild(langBtn); tctl.appendChild(sw);
    row.appendChild(quickBtn); row.appendChild(tctl);

    // 빠른 메시지 목록 창(5장)
    const qpop = el('div', 'mbx-pop mbx-qpop'); qpop.setAttribute('data-part', 'qpop'); qpop.hidden = true;
    const qs = el('div', 'mbx-qsearch');
    qs.appendChild(svg(ICON_SEARCH, '0 0 16 16'));
    const qsearch = el('input'); qsearch.type = 'text'; qsearch.setAttribute('data-part', 'qsearch');
    qsearch.setAttribute('placeholder', '제목, 본문, 태그 검색'); qsearch.setAttribute('aria-label', '빠른 메시지 검색');
    qsearch.setAttribute('autocomplete', 'off'); qsearch.setAttribute('role', 'combobox'); qsearch.setAttribute('aria-expanded', 'true');
    qsearch.addEventListener('input', function () { qIndex = 0; renderQuick(); });
    qsearch.addEventListener('keydown', onQuickKey);
    qs.appendChild(qsearch);
    const qlist = el('div', 'mbx-qlist'); qlist.setAttribute('data-part', 'qlist'); qlist.setAttribute('role', 'listbox');
    qlist.setAttribute('aria-label', '빠른 메시지'); qlist.id = 'mbx-qlist';
    qsearch.setAttribute('aria-controls', 'mbx-qlist');
    const qfoot = el('div', 'mbx-qfoot');
    const qmanage = keepFocus(el('button', 'mbx-link', '설정에서 관리'));
    qmanage.type = 'button'; qmanage.setAttribute('data-part', 'qmanage');
    qmanage.addEventListener('click', function () { closePops(); util.send('OPEN_OPTIONS', { section: 'quick' }); });
    qfoot.appendChild(qmanage);
    qpop.appendChild(qs); qpop.appendChild(qlist); qpop.appendChild(qfoot);

    // 언어 목록(4-4)
    const lpop = el('div', 'mbx-pop mbx-lpop'); lpop.setAttribute('data-part', 'langpop'); lpop.hidden = true;
    const llist = el('ul'); llist.setAttribute('data-part', 'langlist'); llist.setAttribute('role', 'listbox');
    llist.setAttribute('aria-label', '보낼 언어'); llist.tabIndex = -1;
    llist.addEventListener('keydown', onLangKey);
    lpop.appendChild(llist);

    // 겹쳐 뜨는 창은 mbx-root 로 옮겨질 수 있으므로 창 자체에도 이벤트 전달 차단을 건다(2장 10번).
    root.inject.shieldEvents(qpop); root.inject.shieldEvents(lpop);
    sh.appendChild(aux); sh.appendChild(row); sh.appendChild(qpop); sh.appendChild(lpop);
    bar = { host, sh, aux, auxText, quickBtn, tctl, state, langBtn, langName, sw, qpop, qs, qsearch, qlist, qfoot, lpop, llist };

    // 창 밖을 누르면 닫는다.
    document.addEventListener('mousedown', function (e) {
      if (!bar || (bar.qpop.hidden && bar.lpop.hidden)) return;
      const path = e.composedPath ? e.composedPath() : [];
      if (path.indexOf(bar.host) >= 0 || path.indexOf(bar.qpop) >= 0 || path.indexOf(bar.lpop) >= 0) return;
      closePops();
    }, true);
    // 다음 입력을 시작하면 안내와 오류를 지운다(4-5).
    document.addEventListener('input', function (e) { if (auxKind && auxKind !== 'sent' && inComposer(e.target)) hideAux(); }, true);
    window.addEventListener('resize', function () { placeFixedPops(); });
  }

  function toolbarAttached() { return !!bar && bar.host.isConnected; }

  // 입력창 영역: 입력창에서 부모로 올라가며 대화 영역을 함께 포함하는 첫 조상을 찾고, 그 자식 중 입력창을 포함하는 것(4-2).
  function composerArea() {
    const c = sel.composer();
    const region = sel.messageRegion();
    if (!c || !region) return null;
    let a = c.parentElement;
    while (a && !a.contains(region)) a = a.parentElement;
    if (!a) return null;
    let child = c;
    while (child && child.parentElement !== a) child = child.parentElement;
    return child ? { parent: a, area: child, region: region } : null;
  }

  function removeToolbars() {
    const all = document.querySelectorAll('[data-mbx="toolbar"]');
    for (let i = 0; i < all.length; i++) all[i].remove();
    closePops();
  }

  // 막대를 제자리에 1개만 둔다. 둘 수 없는 화면이면 지운다. 넣었으면(또는 이미 있으면) true.
  function ensureToolbar() {
    if (!bar) return false;
    if (!currentThread() || !sel.composer() || blockedNow()) { removeToolbars(); return false; }
    const where = composerArea();
    if (!where) return toolbarAttached();
    const all = document.querySelectorAll('[data-mbx="toolbar"]');
    for (let i = 0; i < all.length; i++) if (all[i] !== bar.host) all[i].remove();
    if (bar.host.isConnected && bar.host.parentElement === where.parent && bar.host.nextElementSibling === where.area) return true;
    if (insertBlocked) return false;
    try {
      // 막대가 들어가면 대화 영역이 36px 줄어든다. 맨 아래에 있었으면 맨 아래를 유지한다(3-6).
      root.inject.keepScroll(where.region, function () { where.parent.insertBefore(bar.host, where.area); });
    } catch (e) { console.debug('toolbar insert failed'); }
    return toolbarAttached();
  }

  // 4-2 "막대 없음" 판정. 입력창이 있는 대화 화면인데 5초 넘게 막대를 넣지 못했으면 참. 막대가 들어가면 즉시 풀린다.
  function checkToolbar(now) {
    const context = !!currentThread() && !!sel.composer() && !blockedNow() && guardActive();
    if (!context || toolbarAttached()) { toolbarSince = 0; toolbarMissing = false; return; }
    if (!toolbarSince) { toolbarSince = now; return; }
    if (now - toolbarSince > NO_TOOLBAR_MS) toolbarMissing = true;
  }

  // ---- 보조 표시(4-5): 막대 위에 겹쳐 띄우는 한 줄. 자리를 차지하지 않는다 ----
  // kind: 'sent'(보낸 원문, 5초) | 'info'(안내) | 'error'(오류). 오류와 안내는 닫거나 다음 입력을 시작하면 사라진다.
  // 막대가 없으면 안내와 오류는 기존 토스트로 표시한다(보낸 원문은 표시하지 않는다).
  function notify(text, kind) {
    const k = kind || 'info';
    // 막대가 없거나 로그인·보안 확인 화면이면(곧 막대가 지워진다) 토스트로 보낸다. 보낸 원문은 막대 위에만 보인다.
    if (!toolbarAttached() || blockedNow()) { if (k !== 'sent') util.toast(text); return; }
    if (k === 'sent' && (auxKind === 'error' || auxKind === 'info')) return; // 오류가 원문 표시보다 우선한다
    clearTimeout(auxTimer); auxTimer = null;
    auxKind = k;
    bar.auxText.textContent = text;
    bar.aux.classList.toggle('mbx-err', k === 'error');
    bar.aux.hidden = false;
    if (k === 'sent') auxTimer = setTimeout(hideAux, SENT_SHOW_MS);
  }
  function hideAux() {
    clearTimeout(auxTimer); auxTimer = null;
    auxKind = null;
    if (!bar) return;
    bar.aux.hidden = true;
    bar.auxText.textContent = '';
  }

  // ---- 겹쳐 뜨는 창 ----
  function closePops() {
    if (!bar) return;
    bar.qpop.hidden = true; bar.lpop.hidden = true;
    bar.quickBtn.setAttribute('aria-expanded', 'false');
    bar.langBtn.setAttribute('aria-expanded', 'false');
  }

  // 조상의 overflow 에 잘리면 mbx-root 로 옮겨 position: fixed 로 띄운다. 잘리지 않으면 막대 안으로 되돌린다.
  function clipped(pop) {
    const pr = pop.getBoundingClientRect();
    for (let a = bar.host.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      let cs = null;
      try { cs = getComputedStyle(a); } catch (e) { cs = null; }
      if (!cs || (cs.overflow === 'visible' && cs.overflowX === 'visible' && cs.overflowY === 'visible')) continue;
      const ar = a.getBoundingClientRect();
      if (pr.top < ar.top - 0.5 || pr.left < ar.left - 0.5 || pr.right > ar.right + 0.5) return true;
    }
    return pr.top < 0;
  }
  function placePop(pop) {
    if (pop.parentNode !== bar.sh) { bar.sh.appendChild(pop); pop.classList.remove('mbx-fixed'); pop.style.cssText = ''; }
    if (!clipped(pop)) return;
    const h = util.host();
    if (!rootStyled) { const st = el('style'); st.textContent = POP_CSS; h.appendChild(st); rootStyled = true; }
    h.appendChild(pop);
    pop.classList.add('mbx-fixed');
    placeFixed(pop);
  }
  function placeFixed(pop) {
    const r = bar.host.getBoundingClientRect();
    pop.style.bottom = Math.max(0, window.innerHeight - r.top + 4) + 'px';
    if (pop === bar.qpop) { pop.style.left = (r.left + 12) + 'px'; pop.style.width = Math.max(200, Math.min(360, r.width - 24)) + 'px'; }
    else { pop.style.left = 'auto'; pop.style.right = Math.max(0, window.innerWidth - r.right + 12) + 'px'; }
  }
  function placeFixedPops() {
    if (!bar) return;
    [bar.qpop, bar.lpop].forEach(function (p) { if (!p.hidden && p.classList.contains('mbx-fixed')) placeFixed(p); });
  }

  // ---- 번역 조작부(4-4) ----
  function onSwitch() {
    const cur = currentLang();
    if (cur === null || busy) return;
    setThreadState(cur.lang, !cur.on);
  }

  function toggleLangMenu() {
    if (!bar) return;
    const open = bar.lpop.hidden;
    closePops();
    const cur = currentLang();
    if (!open || cur === null || busy) return;
    bar.llist.textContent = '';
    lIndex = Math.max(0, LANGS.findIndex(function (l) { return l[0] === cur.lang; }));
    LANGS.forEach(function (l, i) {
      const li = el('li');
      li.setAttribute('role', 'option');
      li.setAttribute('data-code', l[0]);
      li.setAttribute('aria-selected', String(i === lIndex));
      if (l[0] === cur.lang) li.className = 'mbx-cur';
      li.appendChild(svg(ICON_CHECK, '0 0 14 14', { w: '1.8' }));
      li.appendChild(el('span', '', root.langName(l[0])));
      li.appendChild(el('span', 'mbx-cd', l[0]));
      li.addEventListener('mousedown', function (e) { e.preventDefault(); });
      li.addEventListener('mouseenter', function () { lIndex = i; markLang(); });
      li.addEventListener('click', function () { pickLang(l[0]); });
      bar.llist.appendChild(li);
    });
    bar.lpop.hidden = false;
    bar.langBtn.setAttribute('aria-expanded', 'true');
    placePop(bar.lpop);
    bar.llist.focus();
    const curLi = bar.llist.children[lIndex];
    if (curLi && curLi.scrollIntoView) curLi.scrollIntoView({ block: 'nearest' });
  }
  function markLang() {
    const items = bar.llist.children;
    for (let i = 0; i < items.length; i++) items[i].setAttribute('aria-selected', String(i === lIndex));
  }
  // 언어를 고르면 스위치가 꺼져 있어도 켠다(저장 요청 한 번에 언어와 켜짐을 함께 보낸다).
  function pickLang(code) {
    closePops();
    setThreadState(code, true);
    const c = sel.composer(); if (c) c.focus();
  }
  function onLangKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      lIndex = (lIndex + (e.key === 'ArrowDown' ? 1 : -1) + LANGS.length) % LANGS.length;
      markLang();
      const li = bar.llist.children[lIndex]; if (li && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (LANGS[lIndex]) pickLang(LANGS[lIndex][0]);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.preventDefault();
      closePops();
      bar.langBtn.focus();
    }
  }

  // ---- 빠른 메시지 목록 창(5장) ----
  function toggleQuick() {
    if (!bar) return;
    const open = bar.qpop.hidden;
    closePops();
    if (!open) return;
    bar.qsearch.value = ''; qIndex = 0;
    bar.qpop.hidden = false;
    bar.quickBtn.setAttribute('aria-expanded', 'true');
    bar.qs.hidden = true; bar.qfoot.hidden = true;
    bar.qlist.textContent = '';
    bar.qlist.appendChild(el('div', 'mbx-qempty', '불러오는 중…'));
    placePop(bar.qpop);
    loadQuick().then(function (items) {
      if (bar.qpop.hidden) return;
      if (items === null) { bar.qlist.textContent = ''; bar.qlist.appendChild(el('div', 'mbx-qempty', '빠른 메시지를 불러오지 못했습니다')); return; }
      renderQuick();
      if (items.length) bar.qsearch.focus();
    });
  }

  function renderQuick() {
    const items = quick || [];
    bar.qlist.textContent = '';
    bar.qs.hidden = items.length === 0;
    bar.qfoot.hidden = items.length === 0;
    if (items.length === 0) {
      const d = el('div', 'mbx-qempty');
      d.appendChild(el('div', '', '저장된 빠른 메시지가 없습니다'));
      const add = keepFocus(el('button', 'mbx-pill', '설정에서 추가'));
      add.type = 'button';
      add.addEventListener('click', function () { closePops(); util.send('OPEN_OPTIONS', { section: 'quick' }); });
      d.appendChild(add);
      bar.qlist.appendChild(d);
      qFiltered = [];
      return;
    }
    const q = bar.qsearch.value.trim();
    qFiltered = items.filter(function (it) { return matches(it, q); });
    if (qFiltered.length === 0) { bar.qlist.appendChild(el('div', 'mbx-qempty', '검색 결과가 없습니다')); bar.qsearch.removeAttribute('aria-activedescendant'); return; }
    if (qIndex >= qFiltered.length) qIndex = qFiltered.length - 1;
    qFiltered.forEach(function (it, i) {
      const d = el('div', 'mbx-qi');
      d.setAttribute('role', 'option');
      d.id = 'mbx-qo-' + i;
      d.setAttribute('aria-selected', String(i === qIndex));
      const r1 = el('div', 'mbx-qr1');
      r1.appendChild(el('span', 'mbx-qt', it.title));
      (Array.isArray(it.tags) ? it.tags : []).slice(0, 2).forEach(function (t) { r1.appendChild(el('span', 'mbx-tag', '#' + t)); });
      d.appendChild(r1);
      d.appendChild(el('div', 'mbx-qb', String(it.text)));
      d.addEventListener('mousedown', function (e) { e.preventDefault(); });
      d.addEventListener('mouseenter', function () { qIndex = i; markQuick(); });
      d.addEventListener('click', function () { chooseQuick(it); });
      bar.qlist.appendChild(d);
    });
    markQuick();
  }
  function markQuick() {
    const items = bar.qlist.querySelectorAll('.mbx-qi');
    for (let i = 0; i < items.length; i++) items[i].setAttribute('aria-selected', String(i === qIndex));
    bar.qsearch.setAttribute('aria-activedescendant', 'mbx-qo-' + qIndex);
    const cur = items[qIndex]; if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }

  function onQuickKey(e) {
    if (e.isComposing || e.keyCode === 229) return; // 한글 조합 중에는 검색란이 처리한다
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (qFiltered.length === 0) return;
      qIndex = (qIndex + (e.key === 'ArrowDown' ? 1 : -1) + qFiltered.length) % qFiltered.length;
      markQuick();
    } else if (e.key === 'Enter') {
      e.preventDefault(); // 이 창의 Enter 는 번역 전송 가로채기 대상이 아니다(입력창 밖이다)
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
      if (!ok) notify('입력창에 넣지 못했습니다. 입력창을 한 번 클릭한 뒤 다시 시도하세요', 'error');
    });
  }

  // ---- 그리기 ----
  function render() {
    const attached = ensureToolbar();
    if (!attached) return;
    const s = curSettings() || {};
    if (sel.dialogOpen()) closePops(); // Meta 대화상자가 열리면 겹쳐 뜨는 창만 닫는다(2장 11번)
    bar.quickBtn.hidden = s.quickRepliesEnabled === false;
    if (s.quickRepliesEnabled === false && !bar.qpop.hidden) closePops();
    const off = s.sendTranslateEnabled === false; // 전체 기능 꺼짐: 조작부 전체를 숨긴다
    bar.tctl.hidden = off;
    if (off && !bar.lpop.hidden) closePops();
    const cur = currentLang();
    bar.state.className = 'mbx-state';
    if (cur === null) {
      bar.state.textContent = '번역 …';
      bar.langName.textContent = '…';
    } else {
      bar.langName.textContent = root.langName(cur.lang);
      if (busy) { bar.state.textContent = '번역 중…'; bar.state.classList.add('mbx-busy'); }
      else if (cur.on) { bar.state.textContent = '번역 ON'; bar.state.classList.add('mbx-on'); }
      else bar.state.textContent = '번역 OFF';
    }
    bar.langBtn.classList.toggle('mbx-off', cur !== null && !cur.on);
    bar.langBtn.setAttribute('aria-label', '보낼 언어: ' + (cur === null ? '불러오는 중' : root.langName(cur.lang)));
    bar.sw.setAttribute('aria-checked', String(cur !== null && cur.on));
    bar.sw.disabled = cur === null || busy;
    bar.langBtn.disabled = cur === null || busy;
  }

  function tick() {
    // 대화 전환 감지(주소 변화 콜백보다 먼저일 수 있다). 대화가 바뀌면 언어를 다시 불러온다.
    const tid = currentThread();
    if (tid !== loadingThread) { closePops(); onThreadChanged(); loadLang(); }
    // 직전 번역 결과 기록은 입력창이 비워지면 지운다(8-2 보충).
    if (lastTranslated !== null && !busy && text() === '') { lastTranslated = null; lastTranslatedThread = null; }
    // 격리는 입력창 내용이 그 번역문이 아니게 되면(수정·비움) 푼다.
    if (quarantineText !== null && inflightTranslation === null && !quarantined()) quarantineText = null;
    checkComposerPresent(tid);
    render();
    checkToolbar(Date.now());
  }

  function init() {
    trackSelection();
    build();
    util.onMessage('SETTINGS_CHANGED', function (msg) {
      if (msg && msg.quickRepliesChanged) quickDirty = true;
      render();
    });
    util.onInboxChange(function () { tick(); });
    const t = setInterval(tick, TICK_MS);
    if (t && typeof t.unref === 'function') t.unref(); // node 테스트가 끝나도록
    tick();
  }

  root.composer = {
    notify: notify,
    insertText: insertText,
    currentLang: currentLang,
    text: text,
    _decideFallback: decideFallback,
    _isReflected: isReflected,
    _selectAll: selectAll,
    // 전송 가로채기 테스트용(test/composer-send.test.js)
    _gate: {
      onKeyEvent: onKeyEvent, onPointerEvent: onPointerEvent, onCompositionEnd: onCompositionEnd, onFocusOut: onFocusOut,
      onThreadChanged: onThreadChanged,
      state: function () { return { busy: busy, lastTranslated: lastTranslated, pending: pendingActive(), bypass: bypassActive(), quarantine: quarantineText }; },
      checkComposerPresent: checkComposerPresent, tickClear: function () { if (quarantineText !== null && inflightTranslation === null && !quarantined()) quarantineText = null; },
      setLang: function (tid, l) { lang = l; langThread = tid; loadingThread = tid; },
      setToolbarMissing: function (v) { toolbarMissing = !!v; }
    },
    // 도구 막대 테스트용(test/toolbar.test.js)
    _ui: {
      tick: tick, checkToolbar: checkToolbar,
      toolbarMissing: function () { return toolbarMissing; },
      blockInsert: function (v) { insertBlocked = !!v; },
      reset: function () {
        removeToolbars(); hideAux(); toolbarSince = 0; toolbarMissing = false; insertBlocked = false;
        lang = null; langThread = null; loadingThread = undefined; quick = null; quickDirty = true; localSettings = null;
      }
    }
  };

  if (typeof document !== 'undefined' && typeof window !== 'undefined' && root.sel && root.util) {
    // 전송 가로채기 리스너는 Meta보다 먼저 실행되도록 document_start(스크립트 로드 즉시)에 window capture로 건다.
    registerSendGate();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }
})(self.MBX = self.MBX || {});
