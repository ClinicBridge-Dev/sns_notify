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
  let sentTimer = null;
  let quarantineText = null; // 대화 전환 중에 들어갔을 수 있는 번역문(정규화). 입력창이 이 내용이면 전송을 막는다
  let inflightTranslation = null; // 지금 입력창에 넣고 있는 번역문(정규화). 넣기가 끝나면 null
  let noComposerSince = 0;   // 대화 화면인데 입력창을 못 찾은 시각
  let noComposerNotified = null; // 안내한 대화 번호(대화마다 1회)

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
      lang: l,
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
      if (!extAlive()) { util.toast(MSG_RELOAD); return; }
      // 설정은 있는데 대화 번호(selected_item_id)가 없으면 언어를 불러올 수 없다.
      if (curSettings() && !currentThread()) { util.toast(MSG_NO_THREAD); return; }
      util.toast(MSG_LOADING);
      if (!util.settings()) reloadSettings();
      loadLang();
      return;
    }
    if (d === 'block_disconnected') util.toast(MSG_RELOAD);
    if (d === 'block_screen') util.toast(MSG_BLOCKED_SCREEN);
    if (d === 'quarantine') util.toast(MSG_WRONG_THREAD);
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
      if (currentThread() !== tid) { util.toast(MSG_THREAD); return; }
      if (sel.composer() !== c || normalize(text()) !== originalNorm) { util.toast(MSG_EDITED); return; }
      if (!res || res.ok !== true || typeof res.text !== 'string' || normalize(res.text) === '') { util.toast(failText(res)); return; }
      const translated = res.text;
      const want = normalize(translated);
      if (blockedNow()) { util.toast(MSG_BLOCKED_SCREEN); return; } // 금지 사항 9: 번역 중에 로그인·보안 확인 화면이 떴다
      const stale = function () { return my !== flowSeq || currentThread() !== tid; };
      // 넣는 동안 대화가 바뀌면 onThreadChanged가 이 번역문을 바로 격리한다(넣기가 끝나기 전의 틈을 막는다).
      inflightTranslation = want;
      let ok;
      try { ok = await insertText(translated, { replaceAll: true, abort: stale }); } finally { inflightTranslation = null; }
      if (stale()) {
        // 넣는 도중 대화가 바뀌었다. Meta가 같은 입력창을 다시 쓰면 번역문이 다른 대화의 입력창에 있을 수 있다.
        // 그 내용은 격리해 다음 Enter·전송 버튼에서도 Meta에 넘기지 않는다(입력창을 고치거나 비우면 풀린다).
        if (sel.composer() && normalize(text()) === want) { quarantineText = want; util.toast(MSG_WRONG_THREAD); }
        else if (my === flowSeq) util.toast(MSG_THREAD);
        return;
      }
      if (!ok || sel.composer() !== c || normalize(text()) !== want) {
        // 교체 실패: 전송하지 않는다. 가능하면 원문을 복원한다.
        let restored = sel.composer() === c && normalize(text()) === originalNorm;
        if (!restored && sel.composer() === c) restored = await insertText(original, { replaceAll: true, abort: stale });
        util.toast(restored ? MSG_REPLACE : MSG_REPLACE_RESTORE);
        return;
      }
      lastTranslated = want; lastTranslatedThread = tid;
      if (root.hasHangul(translated)) { util.toast(MSG_LEFTOVER); return; }
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
      util.toast(MSG_EDITED); return;
    }
    if (blockedNow()) { util.toast(MSG_BLOCKED_SCREEN); return; } // 금지 사항 9: 이어서 전송하지 않는다
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
      util.toast(MSG_MANUAL); // 번역문에는 한글이 없으므로 다음 Enter는 그대로 전송된다
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

  // 전송 직후 한글 원문을 막대 아래에 5초간 보여 준다. 저장하지 않는다.
  function showSentOriginal(original) {
    if (!ui) return;
    clearTimeout(sentTimer);
    ui.sent.textContent = '보낸 원문: ' + String(original).replace(/\s+/g, ' ').trim();
    ui.sent.style.display = 'block';
    sentTimer = setTimeout(hideSentOriginal, SENT_SHOW_MS);
  }
  function hideSentOriginal() {
    clearTimeout(sentTimer);
    if (!ui) return;
    ui.sent.textContent = '';
    ui.sent.style.display = 'none';
  }

  // 대화가 바뀌면 처리 중인 흐름을 즉시 중단하고 기록을 지운다.
  function onThreadChanged() {
    clearPending();
    lastTranslated = null; lastTranslatedThread = null;
    bypassUntil = 0; bypassText = null;
    if (inflightTranslation !== null) quarantineText = inflightTranslation; // 붙여넣기가 늦게 반영돼도 새 대화에서 넘기지 않는다
    if (busy) { flowSeq++; busy = false; util.toast(MSG_THREAD); }
    hideSentOriginal();
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
    '.mbx-outline{position:fixed;display:none;box-sizing:border-box;border:2px solid #2d8cff;border-radius:10px;pointer-events:none}' +
    '.mbx-busy{position:fixed;display:none;box-sizing:border-box;border:2px solid #f08c00;border-radius:10px;pointer-events:none;' +
    'background:rgba(255,255,255,.55)}' +
    '.mbx-busy-label{position:absolute;right:8px;top:50%;transform:translateY(-50%);padding:2px 8px;border-radius:10px;' +
    'background:#f08c00;color:#fff;font:12px/1.4 system-ui,sans-serif}' +
    '.mbx-sent{position:absolute;left:0;top:100%;margin-top:2px;max-width:400px;display:none;padding:2px 6px;border-radius:6px;' +
    'background:rgba(255,255,255,.9);color:#555;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}';

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
    const sent = el('div', 'mbx-sent');
    bar.appendChild(quickBtn); bar.appendChild(langBtn); bar.appendChild(langMenu); bar.appendChild(qpanel); bar.appendChild(sent);
    const outline = el('div', 'mbx-outline');
    const busyEl = el('div', 'mbx-busy');
    busyEl.appendChild(el('span', 'mbx-busy-label', '번역 중…'));
    h.appendChild(bar); h.appendChild(outline); h.appendChild(busyEl);
    ui = { bar, quickBtn, langBtn, langMenu, qpanel, qsearch, qlist, outline, sent, busy: busyEl };

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
    // 금지 사항 9: 로그인·보안 확인·캡차 화면에서는 막대를 숨긴다.
    const visible = !!(r && r.width > 0 && r.height > 0 && currentThread() && !sel.dialogOpen() && !blockedNow());
    if (!visible) { ui.bar.style.display = 'none'; ui.outline.style.display = 'none'; ui.busy.style.display = 'none'; closePops(); return; }
    ui.bar.style.display = 'flex';
    ui.bar.style.left = Math.max(4, r.left) + 'px';
    ui.bar.style.bottom = Math.max(0, window.innerHeight - r.top + 6) + 'px';
    ui.quickBtn.style.display = s.quickRepliesEnabled === false ? 'none' : '';
    if (s.quickRepliesEnabled === false) ui.qpanel.classList.remove('mbx-open');
    const cur = currentLang();
    ui.langBtn.textContent = '번역: ' + (cur === null ? '…' : cur === 'OFF' ? '끔' : cur) + ' ▾';
    ui.langBtn.disabled = cur === null;
    const active = s.sendTranslateEnabled !== false && cur !== null && cur !== 'OFF';
    if (active) {
      ui.outline.style.display = 'block';
      ui.outline.style.left = (r.left - 2) + 'px'; ui.outline.style.top = (r.top - 2) + 'px';
      ui.outline.style.width = (r.width + 4) + 'px'; ui.outline.style.height = (r.height + 4) + 'px';
    } else ui.outline.style.display = 'none';
    // "번역 중" 표시: Meta 요소의 스타일은 바꾸지 않고 입력창 위에 겹쳐 그린다.
    if (busy) {
      ui.busy.style.display = 'block';
      ui.busy.style.left = (r.left - 2) + 'px'; ui.busy.style.top = (r.top - 2) + 'px';
      ui.busy.style.width = (r.width + 4) + 'px'; ui.busy.style.height = (r.height + 4) + 'px';
    } else ui.busy.style.display = 'none';
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
    if (tid !== loadingThread) { closePops(); onThreadChanged(); loadLang(); }
    // 직전 번역 결과 기록은 입력창이 비워지면 지운다(8-2 보충).
    if (lastTranslated !== null && !busy && text() === '') { lastTranslated = null; lastTranslatedThread = null; }
    // 격리는 입력창 내용이 그 번역문이 아니게 되면(수정·비움) 푼다.
    if (quarantineText !== null && inflightTranslation === null && !quarantined()) quarantineText = null;
    checkComposerPresent(tid);
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
    _decideFallback: decideFallback,
    _isReflected: isReflected,
    _selectAll: selectAll,
    // 전송 가로채기 테스트용(test/composer-send.test.js)
    _gate: {
      onKeyEvent: onKeyEvent, onPointerEvent: onPointerEvent, onCompositionEnd: onCompositionEnd, onFocusOut: onFocusOut,
      onThreadChanged: onThreadChanged,
      state: function () { return { busy: busy, lastTranslated: lastTranslated, pending: pendingActive(), bypass: bypassActive(), quarantine: quarantineText }; },
      checkComposerPresent: checkComposerPresent, tickClear: function () { if (quarantineText !== null && inflightTranslation === null && !quarantined()) quarantineText = null; },
      setLang: function (tid, l) { lang = l; langThread = tid; loadingThread = tid; }
    }
  };

  if (typeof document !== 'undefined' && typeof window !== 'undefined' && root.sel && root.util) {
    // 전송 가로채기 리스너는 Meta보다 먼저 실행되도록 document_start(스크립트 로드 즉시)에 window capture로 건다.
    registerSendGate();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }
})(self.MBX = self.MBX || {});
