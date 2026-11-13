// 설정 화면(UI 수정 기획서 6장, 7-1, 7-3). options 페이지는 신뢰 영역이므로 chrome.storage.local을 직접 읽고 쓴다.
// 화면 뼈대는 options.html 에 고정돼 있고, 여기서는 글자와 속성만 바꾼다(입력 중인 값과 포커스를 지키기 위해).
(function () {
  const MBX = self.MBX;
  const H = self.MBX_OPT;
  const $ = function (id) { return document.getElementById(id); };

  const SEND_LANGS = MBX.SEND_LANGS;
  const BUBBLE_LANGS = [['KO', '한국어']].concat(SEND_LANGS);
  const STATUS_REFRESH_MS = 10000;
  const WEBHOOK_PREFIX = 'https://hooks.slack.com/';
  const ICON_CHECK = '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 7.5 2.5 2.5L11 4.5"/></svg>';
  const ICON_GRIP = '<svg viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><circle cx="5" cy="3.5" r="1"/><circle cx="9" cy="3.5" r="1"/><circle cx="5" cy="7" r="1"/><circle cx="9" cy="7" r="1"/><circle cx="5" cy="10.5" r="1"/><circle cx="9" cy="10.5" r="1"/></svg>';
  const ICON_UP = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 7.5 3-3 3 3"/></svg>';
  const ICON_DOWN = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg>';

  // ---- 저장소 ----
  // 쓰기 전에는 항상 다시 읽는다(service worker 가 settings.assetId 를 쓴다).
  async function loadSettings() {
    const { settings } = await chrome.storage.local.get(['settings']);
    return Object.assign({}, MBX.DEFAULT_SETTINGS, settings);
  }

  async function saveSettings(patch) {
    const current = await loadSettings();
    const next = Object.assign({}, current, patch);
    await chrome.storage.local.set({ settings: next });
    return next;
  }

  async function loadQuickReplies() {
    const { quickReplies } = await chrome.storage.local.get(['quickReplies']);
    return quickReplies && Array.isArray(quickReplies.items) ? quickReplies.items : [];
  }

  async function saveQuickReplies(items) {
    await chrome.storage.local.set({ quickReplies: { version: 1, items: items } });
  }

  function newId() {
    return (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'qr-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }

  // ---- 작은 도구 ----
  // kind: undefined(보통) | 'ok' | 'error'
  function setMsg(el, text, kind) {
    el.textContent = text || '';
    el.classList.toggle('error', kind === 'error' || kind === true);
    el.classList.toggle('ok', kind === 'ok');
  }

  let toastTimer = null;
  function toast(text) {
    $('toast-text').textContent = text || '저장됨';
    $('toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $('toast').classList.remove('show'); }, 2000);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function dot(tone) {
    const d = el('span', 'dot tone-' + tone);
    d.setAttribute('aria-hidden', 'true');
    return d;
  }

  function setDd(id, tone, text) {
    const dd = $(id);
    dd.textContent = '';
    if (tone) dd.appendChild(dot(tone));
    dd.appendChild(el('span', tone === 'red' ? 'tone-red txt' : '', text));
  }

  // ================= 메뉴 이동(6-2, 7-3) =================
  let current = null;

  function showSection(sec, opts) {
    opts = opts || {};
    if (!H.isSection(sec)) sec = 'start';
    const changed = sec !== current;
    current = sec;
    document.querySelectorAll('.panel').forEach(function (p) { p.hidden = p.dataset.section !== sec; });
    document.querySelectorAll('nav [data-nav]').forEach(function (b) {
      if (b.dataset.nav === sec) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    if (location.hash !== '#' + sec) {
      if (opts.replace) history.replaceState(null, '', '#' + sec);
      else history.pushState(null, '', '#' + sec);
    }
    document.title = H.SECTION_NAMES[sec] + ' · Meta Inbox Helper 설정';
    if (changed && !opts.initial) {
      window.scrollTo(0, 0);
      if (opts.focusHeading !== false) $('h-' + sec).focus({ preventScroll: true });
    }
    if (opts.focus) focusTarget(opts.focus);
  }

  function focusTarget(what) {
    const map = {
      webhook: function () { return $('webhook-form').hidden ? $('webhook-change') : $('webhook-input'); },
      account: function () { return $('btn-set-asset'); },
      deepl: function () { return $('deepl-form').hidden ? $('deepl-change') : $('deepl-input'); },
      test: function () { return $('btn-test-slack'); }
    };
    const t = map[what] && map[what]();
    if (t) { t.scrollIntoView({ block: 'center' }); t.focus(); }
  }

  // 모든 이동은 여기를 거친다. 저장하지 않은 빠른 메시지 변경이 있으면 먼저 묻는다.
  function navigate(sec, opts) {
    guard(function () { showSection(sec, opts); });
  }

  function initNavigation() {
    document.addEventListener('click', function (e) {
      const g = e.target.closest('[data-go]');
      if (!g) return;
      e.preventDefault();
      navigate(g.dataset.go, { focus: g.dataset.focus, focusHeading: !g.dataset.focus });
    });
    window.addEventListener('hashchange', function () {
      const sec = H.sectionFromHash(location.hash);
      if (sec === current) return;
      if (qr.dirty()) {
        history.replaceState(null, '', '#' + current); // 확인이 끝날 때까지 주소를 되돌린다
        navigate(sec);
        return;
      }
      showSection(sec, { replace: true });
    });
    window.addEventListener('popstate', function () {
      const sec = H.sectionFromHash(location.hash);
      if (sec === current) return;
      if (qr.dirty()) { history.replaceState(null, '', '#' + current); navigate(sec, { replace: true }); return; }
      showSection(sec, { replace: true });
    });
  }

  // service worker 가 적어 둔 메뉴(7-3). 읽고 바로 지운다. 지울 때 생기는 변경 알림(newValue 없음)은 무시한다.
  async function takePendingSection() {
    if (!chrome.storage.session) return null;
    try {
      const r = await chrome.storage.session.get(['pendingOptionsSection']);
      const sec = r && r.pendingOptionsSection;
      if (sec !== undefined) await chrome.storage.session.remove('pendingOptionsSection');
      return typeof sec === 'string' ? sec : null;
    } catch (e) {
      console.debug('pending section read failed');
      return null;
    }
  }

  function initPendingSection() {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'session' || !changes.pendingOptionsSection) return;
      const sec = changes.pendingOptionsSection.newValue;
      if (typeof sec !== 'string') return;
      chrome.storage.session.remove('pendingOptionsSection').catch(function () { console.debug('pending section remove failed'); });
      navigate(H.isSection(sec) ? sec : 'start');
    });
  }

  // ================= 상단 상태 줄, 시작하기 (6-3, 6-4) =================
  let lastStatus = null;

  const STEP_TEXT = {
    permissions: { done: '네 곳 모두 허용돼 있습니다.', todo: '번역과 Slack 알림이 동작하려면 네 곳 모두 허용돼 있어야 합니다.' },
    webhook: { done: '저장됨', todo: 'Slack 알림 메뉴에서 Webhook 주소를 넣으세요.', skip: 'Slack 알림 사용 안 함' },
    account: { done: '지정됨', todo: '수신함 탭을 연 뒤 Slack 알림 메뉴에서 지정하세요.', skip: 'Slack 알림 사용 안 함' },
    deepl: { done: '저장됨', todo: '번역 메뉴에서 DeepL API 키를 넣으세요.' },
    slackTest: { done: '지금 Webhook 주소로 전송 성공', todo: '아직 지금 Webhook 주소로 성공한 기록이 없습니다.', skip: 'Slack 알림 사용 안 함' }
  };
  const STATE_LABEL = { done: '완료', todo: '미완료', skip: '사용 안 함' };

  function renderChip(id, name, r) {
    const b = $(id);
    b.className = 'chip tone-' + r.tone;
    b.dataset.go = r.section;
    b.querySelector('.v').textContent = r.label;
    b.setAttribute('aria-label', name + ' ' + r.label + '. ' + H.SECTION_NAMES[r.section] + ' 메뉴로 이동');
  }

  function renderSteps(st, now) {
    const steps = MBX.startSteps(st);
    let done = 0;
    steps.forEach(function (s, i) {
      const li = $('step-' + s.id);
      const mark = li.querySelector('.mark');
      if (s.state !== 'todo') done++;
      mark.className = 'mark' + (s.state === 'done' ? ' done' : s.state === 'skip' ? ' skip' : s.id === 'permissions' ? ' bad' : '');
      mark.innerHTML = s.state === 'done' ? ICON_CHECK : s.state === 'skip' ? '–' : String(i + 1);
      mark.setAttribute('role', 'img');
      mark.setAttribute('aria-label', (i + 1) + '단계 ' + STATE_LABEL[s.state]);
      let desc = STEP_TEXT[s.id][s.state];
      if (s.id === 'account' && s.state === 'done') desc += ' · ' + st.assetId;
      if (s.id === 'deepl' && s.state === 'done' && st.deepl && st.deepl.free) desc += ' · 무료 키';
      if (s.id === 'slackTest' && s.state === 'done') desc += ' · ' + H.fmtTime(st.slackTestOkAt, now);
      li.querySelector('.desc').textContent = desc;
      const go = li.querySelector('.step-act [data-go]');
      if (go) go.hidden = s.state !== 'todo';
    });
    $('prog-text').textContent = done + ' / ' + steps.length + ' 완료';
    $('prog-bar').style.width = (done / steps.length * 100) + '%';
    const all = done === steps.length;
    $('setup-card').hidden = all;
    $('setup-done').hidden = !all;
  }

  function renderHosts(st) {
    const box = $('hosts');
    box.textContent = '';
    MBX.HOST_ORIGINS.forEach(function (o) {
      const on = !!(st.permissions && st.permissions[o] === true);
      const row = el('div', 'host ' + (on ? 'on' : 'off'));
      row.appendChild(dot(on ? 'green' : 'red'));
      row.appendChild(el('code', '', H.hostOf(o)));
      row.appendChild(el('span', 'st', on ? '허용' : '꺼짐'));
      box.appendChild(row);
    });
    const missing = H.missingOrigins(st.permissions, MBX.HOST_ORIGINS);
    $('btn-grant').hidden = missing.length === 0;
    $('nav-start-badge').hidden = missing.length === 0;
    if (!missing.length) { $('perm-help').hidden = true; if ($('perm-result').classList.contains('error')) setMsg($('perm-result'), ''); }
    $('slack-perm-alert').hidden = !!(st.permissions && st.permissions['https://hooks.slack.com/*'] === true);
  }

  function renderNow(st, now) {
    const det = MBX.detectStatus(st, now);
    if (st.lastHeartbeat) {
      let t = H.fmtTime(st.lastHeartbeat, now) + ' (' + H.fmtAgo(st.lastHeartbeat, now) + ') · ' + det.label;
      if (st.detect && st.detect.failing && st.detect.failReason) t += ': ' + H.failReasonText(st.detect.failReason);
      setDd('st-heartbeat', det.tone, t);
    } else {
      setDd('st-heartbeat', det.tone, '아직 받지 않음 · ' + det.label);
    }
    if (!st.assetId) setDd('st-owner', 'gray', '알림 대상 계정이 지정되지 않았습니다');
    else if (st.ownerTabId !== null && st.ownerTabId !== undefined) setDd('st-owner', 'green', '있음 (탭 ' + st.ownerTabId + ')');
    else setDd('st-owner', 'red', '없음: 대상 계정의 수신함 탭을 여세요');
    const send = H.lastSendText(st.lastSend, now);
    setDd('st-send', send.tone, send.text);
    const q = Number(st.queueLength) || 0;
    setDd('st-queue', null, q + '건' + (st.retryCount > 0 ? ' (재시도 대기 ' + st.retryCount + '건)' : ''));
    const e = st.lastError;
    if (e) setDd('st-error', 'red', (e.at ? H.fmtTime(e.at, now) + ' · ' : '') + (e.message || e.code || '오류'));
    else setDd('st-error', null, '없음');
  }

  function renderSlackSide(st, now) {
    $('asset-current').textContent = st.assetId || '(없음)';
    if (!$('test-slack-result').dataset.fresh) {
      setMsg($('test-slack-result'), st.slackTestOkAt > 0 ? '마지막 성공: ' + H.fmtTime(st.slackTestOkAt, now) : '', 'ok');
    }
  }

  function renderDeeplSide(st, now) {
    const d = st.deepl || {};
    const u = d.hasKey && d.checkedAt > 0 ? H.usageInfo(d.used, d.limit) : null;
    $('deepl-usage').hidden = !u;
    if (u) {
      $('deepl-plan').textContent = d.free ? 'Free' : 'Pro';
      $('deepl-usage-text').textContent = '이번 달 ' + u.text;
      $('deepl-usage-bar').style.width = u.pct + '%';
      $('deepl-usage-bar').classList.toggle('high', u.pct >= 90);
    }
    $('deepl-free-warning').hidden = !(d.hasKey && d.free);
    const out = $('deepl-check-result');
    if (!out.dataset.fresh) {
      if (!d.hasKey) setMsg(out, '');
      else if (!d.checkedAt) setMsg(out, '키를 저장한 뒤 아직 확인하지 않았습니다');
      else if (d.ok) setMsg(out, H.fmtTime(d.checkedAt, now) + ' 확인', 'ok');
      else setMsg(out, '마지막 결과: 확인 실패' + (d.code ? ' (' + d.code + ')' : ''), 'error');
    }
  }

  function renderStatus(st) {
    lastStatus = st;
    const now = Date.now();
    renderChip('chip-detect', '감지', MBX.detectStatus(st, now));
    renderChip('chip-slack', 'Slack', MBX.slackStatus(st));
    renderChip('chip-translate', '번역', MBX.translateStatus(st));
    renderHosts(st);
    renderSteps(st, now);
    renderNow(st, now);
    renderSlackSide(st, now);
    renderDeeplSide(st, now);
  }

  async function refreshStatus() {
    const r = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    if (!r || r.ok === false) return null;
    renderStatus(r);
    return r;
  }

  let refreshTimer = null;
  function refreshSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () { refreshStatus().catch(function () { console.debug('status render failed'); }); }, 250);
  }

  function initStatus() {
    const tick = function () { refreshStatus().catch(function () { console.debug('status render failed'); }); };
    tick();
    setInterval(tick, STATUS_REFRESH_MS);
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      if (changes.lastError || changes.settings || changes.statusInfo || changes.lastSend || changes.slackQueue) refreshSoon();
    });
  }

  // ---- 7-1 [권한 허용]. 사용자 클릭 안에서 바로 요청해야 하므로 await 전에 부른다. ----
  function initPermissions() {
    $('btn-grant').addEventListener('click', function () {
      const missing = H.missingOrigins(lastStatus && lastStatus.permissions, MBX.HOST_ORIGINS);
      let p;
      try { p = chrome.permissions.request({ origins: missing }); } catch (e) { p = Promise.reject(e); }
      Promise.resolve(p).then(function (g) { return g === true; }, function () { return false; }).then(async function (granted) {
        let st = null;
        try { st = await refreshStatus(); } catch (e) { console.debug('status render failed'); }
        const still = H.missingOrigins(st ? st.permissions : null, MBX.HOST_ORIGINS);
        if (granted && st && !still.length) {
          $('perm-help').hidden = true;
          setMsg($('perm-result'), '허용했습니다', 'ok');
        } else {
          $('perm-help').hidden = false;
          setMsg($('perm-result'), '이 화면에서 권한을 허용하지 못했습니다.', 'error');
        }
      });
    });
    $('btn-copy-ext-url').addEventListener('click', async function () {
      const url = 'chrome://extensions/?id=' + chrome.runtime.id;
      try {
        await navigator.clipboard.writeText(url);
        setMsg($('copy-ext-result'), '복사했습니다. 새 탭 주소창에 붙여 넣으세요', 'ok');
      } catch (e) {
        setMsg($('copy-ext-result'), url);
      }
    });
  }

  // ================= 일반 설정 =================
  function fillSelect(sel, options, value) {
    sel.textContent = '';
    options.forEach(function (o) {
      const opt = document.createElement('option');
      opt.value = o[0];
      opt.textContent = o[1];
      sel.appendChild(opt);
    });
    sel.value = value;
  }

  function fillPreviewLen(value) {
    const sel = $('slackPreviewMaxLen');
    const def = MBX.DEFAULT_SETTINGS.slackPreviewMaxLen;
    fillSelect(sel, H.previewLenChoices(value).map(function (n) { return [String(n), n + '자' + (n === def ? ' (기본)' : '')]; }), String(value));
  }

  // 스위치·선택 목록은 바꾸는 즉시 저장하고 "저장됨"을 띄운다(6-5).
  function bindSwitch(key, after) {
    const b = $(key);
    b.addEventListener('click', async function () {
      const next = b.getAttribute('aria-checked') !== 'true';
      b.setAttribute('aria-checked', String(next));
      try {
        const s = await saveSettings({ [key]: next });
        toast();
        if (after) after(s);
      } catch (e) {
        b.setAttribute('aria-checked', String(!next));
        toast('저장하지 못했습니다');
      }
    });
  }

  function bindSelect(id, toValue, after) {
    $(id).addEventListener('change', async function (e) {
      try {
        const s = await saveSettings({ [id]: toValue(e.target.value) });
        toast();
        if (after) after(s);
      } catch (err) { toast('저장하지 못했습니다'); }
    });
  }

  function renderSlackPreview(s) {
    const now = Date.now();
    // 예시 알림의 미확인 대화 수(12-3). 실제 알림은 내보내는 시점의 배지 숫자를 쓴다.
    const p = H.splitSlackPreview(MBX.buildSlackPayload(H.sampleSlackItem(now), s, now, { instagram_direct: 1, wec: 0 }));
    const d = new Date(now);
    $('slk-time').textContent = (d.getHours() < 12 ? '오전 ' : '오후 ') + ((d.getHours() % 12) || 12) + ':' + String(d.getMinutes()).padStart(2, '0');
    $('slk-head').textContent = p.head;
    const box = $('slk-lines');
    box.textContent = '';
    p.lines.forEach(function (l) { box.appendChild(el('p', '', l)); });
  }

  // 비밀값: 저장돼 있으면 가린 표시와 [변경]만 보이고, 입력칸에는 값을 다시 채우지 않는다.
  function renderSecret(prefix, has, maskText) {
    $(prefix + '-masked').hidden = !has;
    $(prefix + '-form').hidden = has;
    $(prefix + '-cancel').hidden = true;
    $(prefix + '-masked-text').textContent = maskText;
    $(prefix + '-input').value = '';
  }

  function openSecretEditor(prefix) {
    $(prefix + '-masked').hidden = true;
    $(prefix + '-form').hidden = false;
    $(prefix + '-cancel').hidden = false;
    $(prefix + '-input').focus();
  }

  function webhookError(v) {
    if (!v) return '';
    if (v.indexOf(WEBHOOK_PREFIX) === 0 || WEBHOOK_PREFIX.indexOf(v) === 0) return ''; // 입력 중인 앞부분은 기다린다
    return 'https://hooks.slack.com/ 으로 시작하는 주소만 쓸 수 있습니다';
  }

  function showWebhookErr(text) {
    $('webhook-err').textContent = text || '';
    $('webhook-input').classList.toggle('bad', !!text);
    $('webhook-input').setAttribute('aria-invalid', text ? 'true' : 'false');
  }

  async function initSettings() {
    const s = await loadSettings();
    ['slackEnabled', 'slackMaskPhone', 'bubbleButtonsEnabled', 'sendTranslateEnabled', 'quickRepliesEnabled'].forEach(function (k) {
      $(k).setAttribute('aria-checked', String(!!s[k]));
    });
    bindSwitch('slackEnabled', function () { refreshSoon(); });
    bindSwitch('slackMaskPhone', renderSlackPreview);
    bindSwitch('bubbleButtonsEnabled');
    bindSwitch('sendTranslateEnabled');
    bindSwitch('quickRepliesEnabled');

    fillPreviewLen(s.slackPreviewMaxLen);
    bindSelect('slackPreviewMaxLen', function (v) {
      const n = Math.floor(Number(v));
      return Number.isFinite(n) && n >= 1 && n <= 1000 ? n : MBX.DEFAULT_SETTINGS.slackPreviewMaxLen;
    }, renderSlackPreview);
    renderSlackPreview(s);

    fillSelect($('bubbleTargetLang'), BUBBLE_LANGS, s.bubbleTargetLang);
    fillSelect($('sendTargetLang'), SEND_LANGS, s.sendTargetLang);
    bindSelect('bubbleTargetLang', function (v) { return v; });
    bindSelect('sendTargetLang', function (v) { return v; });

    // 계정 이름: [저장]을 눌러야 저장한다(6-5).
    $('accountName').value = s.accountName;
    $('accountName').addEventListener('input', function () { setMsg($('account-msg'), ''); });
    $('account-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      const name = $('accountName').value.trim();
      const next = await saveSettings({ accountName: name });
      $('accountName').value = name;
      setMsg($('account-msg'), name ? '저장했습니다' : '계정 이름을 지웠습니다', 'ok');
      toast();
      renderSlackPreview(next);
    });

    // Webhook
    renderSecret('webhook', !!s.slackWebhookUrl, H.maskedWebhook(s.slackWebhookUrl));
    $('webhook-change').addEventListener('click', function () { setMsg($('webhook-msg'), ''); openSecretEditor('webhook'); });
    $('webhook-cancel').addEventListener('click', function () {
      showWebhookErr('');
      renderSecret('webhook', true, $('webhook-masked-text').textContent);
      $('webhook-change').focus();
    });
    $('webhook-input').addEventListener('input', function (e) { showWebhookErr(webhookError(e.target.value.trim())); setMsg($('webhook-msg'), ''); });
    $('webhook-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      const url = $('webhook-input').value.trim();
      const v = MBX.validateWebhookUrl(url);
      if (!v.ok) { showWebhookErr(v.reason); $('webhook-input').focus(); return; }
      showWebhookErr('');
      await saveSettings({ slackWebhookUrl: url });
      renderSecret('webhook', !!url, H.maskedWebhook(url));
      setMsg($('webhook-msg'), url ? '저장했습니다' : 'Webhook 주소를 지웠습니다', 'ok');
      delete $('test-slack-result').dataset.fresh;
      toast();
      refreshSoon();
    });

    // DeepL 키
    renderSecret('deepl', !!s.deeplApiKey, H.maskedKey(s.deeplApiKey));
    $('deepl-change').addEventListener('click', function () { setMsg($('deepl-msg'), ''); openSecretEditor('deepl'); });
    $('deepl-cancel').addEventListener('click', function () {
      renderSecret('deepl', true, $('deepl-masked-text').textContent);
      $('deepl-change').focus();
    });
    $('deepl-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      const key = $('deepl-input').value.trim();
      await saveSettings({ deeplApiKey: key });
      renderSecret('deepl', !!key, H.maskedKey(key));
      setMsg($('deepl-msg'), key ? '저장했습니다' : 'DeepL 키를 지웠습니다', 'ok');
      delete $('deepl-check-result').dataset.fresh;
      toast();
      refreshSoon();
    });
  }

  function initDeeplCheck() {
    $('btn-check-deepl').addEventListener('click', async function () {
      const out = $('deepl-check-result');
      const btn = $('btn-check-deepl');
      btn.disabled = true;
      out.dataset.fresh = '1';
      setMsg(out, '확인 중...');
      try {
        const r = await chrome.runtime.sendMessage({ type: 'CHECK_DEEPL_KEY' });
        if (r && r.ok) setMsg(out, '키가 정상입니다 · 사용량 ' + Number(r.used).toLocaleString('ko-KR') + ' / ' + Number(r.limit).toLocaleString('ko-KR') + '자', 'ok');
        else setMsg(out, (r && r.message) || '확인하지 못했습니다', 'error');
      } catch (e) {
        setMsg(out, '확인하지 못했습니다', 'error');
      } finally {
        btn.disabled = false;
        refreshSoon();
      }
    });
  }

  // 테스트 메시지: service worker 가 대기열을 거치지 않고 바로 보낸 결과를 돌려받는다(실패해도 재시도하지 않는다).
  function initSlackTest() {
    const btn = $('btn-test-slack');
    btn.addEventListener('click', async function () {
      const out = $('test-slack-result');
      btn.disabled = true;
      out.dataset.fresh = '1';
      setMsg(out, '보내는 중...');
      try {
        const r = await chrome.runtime.sendMessage({ type: 'SEND_TEST_SLACK' });
        if (r && r.ok) setMsg(out, 'Slack으로 보냈습니다', 'ok');
        else setMsg(out, (r && r.message) || '보내지 못했습니다', 'error'); // PERMISSION_OFF 포함, 받은 문구 그대로
      } catch (e) {
        setMsg(out, '보내지 못했습니다', 'error');
      } finally {
        btn.disabled = false;
        refreshSoon();
      }
    });
  }

  // ---- 알림 대상 지정(기획서 10-4) ----
  // service worker 가 연결된 수신함 탭들이 알려 온 asset_id 를 쓴다. 값이 여러 개면 고르게 한다.
  function renderAssetChoices(ids) {
    const box = $('asset-choices');
    box.textContent = '';
    box.hidden = !ids || !ids.length;
    (ids || []).forEach(function (id) {
      const b = el('button', 'btn sm');
      b.type = 'button';
      b.appendChild(el('code', '', id));
      b.addEventListener('click', function () { requestSetAsset(id); });
      box.appendChild(b);
    });
  }

  async function requestSetAsset(choice) {
    const out = $('asset-result');
    const btn = $('btn-set-asset');
    btn.disabled = true;
    setMsg(out, '확인 중...');
    try {
      const r = await chrome.runtime.sendMessage(choice ? { type: 'SET_ASSET_FROM_OPEN_TAB', assetId: choice } : { type: 'SET_ASSET_FROM_OPEN_TAB' });
      if (r && r.ok) {
        renderAssetChoices(null);
        $('asset-current').textContent = r.assetId;
        setMsg(out, '알림 대상으로 지정했습니다', 'ok');
        toast();
      } else if (r && r.code === 'NO_INBOX_TAB') {
        renderAssetChoices(null);
        setMsg(out, '수신함을 먼저 여세요', 'error');
      } else if (r && r.code === 'MULTIPLE') {
        renderAssetChoices(r.assetIds);
        setMsg(out, '열려 있는 수신함의 계정이 여러 개입니다. 알림 대상을 고르세요');
      } else {
        setMsg(out, '지정하지 못했습니다. 수신함 탭을 새로고침한 뒤 다시 시도하세요', 'error');
      }
    } catch (e) {
      setMsg(out, '지정하지 못했습니다', 'error');
    } finally {
      btn.disabled = false;
      refreshSoon();
    }
  }

  function initSetAsset() {
    $('btn-set-asset').addEventListener('click', function () { requestSetAsset(null); });
  }

  // ================= 빠른 메시지 (6-4) =================
  // editing: null(편집 영역 비어 있음) | { id: null }(새 메시지) | { id }(저장된 항목)
  const qr = {
    items: [],
    editing: null,
    filter: '',
    pending: null, // 확인을 기다리는 이동
    pendingImport: null,
    dragId: null,
    dirty: function () {
      if (!qr.editing) return false;
      const saved = qr.editing.id ? qr.items.find(function (x) { return x.id === qr.editing.id; }) : null;
      return H.isDirty(readForm(), saved || null);
    }
  };

  function readForm() {
    return { title: $('qr-title').value, text: $('qr-text').value, tags: $('qr-tags').value };
  }

  // 저장하지 않은 변경이 있으면 이동을 멈추고 묻는다. 없으면 바로 한다.
  function guard(action) {
    if (!qr.dirty()) {
      qr.pending = null; // 직접 되돌려 변경이 없어졌으면 남은 질문과 미뤄 둔 이동을 버린다
      $('qr-dirty').hidden = true;
      action();
      return;
    }
    qr.pending = action;
    if (current !== 'quick') showSection('quick', { replace: true });
    $('qr-dirty').hidden = false;
    $('qr-discard').focus();
  }

  function clearFieldErrors() {
    $('qr-title-err').textContent = '';
    $('qr-text-err').textContent = '';
    $('qr-form-msg').textContent = '';
    $('qr-title').classList.remove('bad');
    $('qr-text').classList.remove('bad');
  }

  function updateCounter() {
    const n = $('qr-text').value.length;
    $('qr-text-count').textContent = n.toLocaleString('ko-KR') + ' / ' + MBX.QUICK_REPLY_MAX_TEXT.toLocaleString('ko-KR') + '자';
  }

  function updateSaveState() {
    $('qr-save').disabled = !qr.dirty();
  }

  function renderEditor() {
    const ed = qr.editing;
    const saved = ed && ed.id ? qr.items.find(function (x) { return x.id === ed.id; }) : null;
    $('qr-empty').hidden = !!ed || qr.items.length > 0;
    $('qr-form').hidden = !ed;
    $('qr-del-confirm').hidden = true;
    $('qr-actions').hidden = false;
    clearFieldErrors();
    if (!ed) return;
    $('qr-form-title').textContent = saved ? '빠른 메시지 수정' : '새 빠른 메시지';
    $('qr-title').value = saved ? saved.title : '';
    $('qr-text').value = saved ? saved.text : '';
    $('qr-tags').value = saved ? (saved.tags || []).join(', ') : '';
    $('qr-delete').hidden = !saved;
    $('qr-cancel-new').hidden = !!saved;
    updateCounter();
    updateSaveState();
  }

  function renderList() {
    const ul = $('qr-list');
    const shown = H.filterQuickReplies(qr.items, qr.filter);
    const canReorder = !qr.filter.trim();
    const focusedId = document.activeElement && document.activeElement.closest && document.activeElement.closest('.qitem')
      ? document.activeElement.closest('.qitem').dataset.id : null;
    const focusedMv = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.mv : null;
    ul.textContent = '';
    shown.forEach(function (x) {
      const it = x.item;
      const li = el('li', 'qitem' + (canReorder ? '' : ' nodrag'));
      li.setAttribute('role', 'option');
      li.tabIndex = 0;
      li.dataset.id = it.id;
      const selected = !!(qr.editing && qr.editing.id === it.id);
      li.setAttribute('aria-selected', String(selected));
      li.draggable = canReorder;
      const grip = el('span', 'grip');
      grip.innerHTML = ICON_GRIP;
      grip.setAttribute('aria-hidden', 'true');
      li.appendChild(grip);
      li.appendChild(el('span', 'tt', it.title));
      const tags = it.tags || [];
      if (tags.length) li.appendChild(el('span', 'tg', '#' + tags[0] + (tags.length > 1 ? ' +' + (tags.length - 1) : '')));
      const mv = el('span', 'mv');
      [[-1, ICON_UP, '위로 이동'], [1, ICON_DOWN, '아래로 이동']].forEach(function (d) {
        const b = el('button');
        b.type = 'button';
        b.dataset.mv = String(d[0]);
        b.innerHTML = d[1];
        b.setAttribute('aria-label', '"' + it.title + '" ' + d[2]);
        b.title = canReorder ? d[2] : '검색 중에는 순서를 바꿀 수 없습니다';
        b.disabled = !canReorder || (d[0] < 0 ? x.index === 0 : x.index === qr.items.length - 1);
        mv.appendChild(b);
      });
      li.appendChild(mv);
      ul.appendChild(li);
    });
    $('qr-count').textContent = qr.items.length + '개';
    $('qr-none').hidden = !(qr.items.length && !shown.length);
    $('qr-none').textContent = '"' + qr.filter.trim() + '"에 맞는 빠른 메시지가 없습니다.';
    if (!qr.items.length) { $('qr-none').hidden = false; $('qr-none').textContent = '등록된 빠른 메시지가 없습니다.'; }
    if (focusedId) {
      const li = ul.querySelector('[data-id="' + CSS.escape(focusedId) + '"]');
      const t = li && (focusedMv ? li.querySelector('[data-mv="' + focusedMv + '"]') : li);
      if (t) (t.disabled ? li : t).focus();
    }
  }

  function selectItem(id) {
    qr.editing = id ? { id: id } : null;
    $('qr-dirty').hidden = true;
    renderList();
    renderEditor();
  }

  function startNew() {
    guard(function () {
      if (current !== 'quick') showSection('quick');
      qr.editing = { id: null };
      $('qr-dirty').hidden = true;
      renderList();
      renderEditor();
      $('qr-title').focus();
    });
  }

  async function reloadItems() {
    qr.items = await loadQuickReplies();
    if (qr.editing && qr.editing.id && !qr.items.some(function (x) { return x.id === qr.editing.id; })) {
      qr.editing = qr.items.length ? { id: qr.items[0].id } : null; // 다른 곳에서 지워졌다
      renderEditor();
    }
    renderList();
    if (!qr.editing) $('qr-empty').hidden = qr.items.length > 0;
  }

  async function reorder(next) {
    if (!next) return;
    await saveQuickReplies(next);
    qr.items = next;
    renderList();
    toast();
  }

  async function onSave(e) {
    e.preventDefault();
    clearFieldErrors();
    const f = readForm();
    const entry = { id: (qr.editing && qr.editing.id) || newId(), title: f.title, text: f.text, tags: H.parseTags(f.tags) };
    const v = MBX.validateImport([entry]);
    if (!v.ok) {
      const reason = v.errors[0].reason;
      if (/^title/.test(reason)) { $('qr-title-err').textContent = reason.replace(/^title/, '제목'); $('qr-title').classList.add('bad'); $('qr-title').focus(); }
      else if (/^text/.test(reason)) { $('qr-text-err').textContent = reason.replace(/^text/, '본문'); $('qr-text').classList.add('bad'); $('qr-text').focus(); }
      else $('qr-form-msg').textContent = reason;
      return;
    }
    const items = await loadQuickReplies();
    const at = items.findIndex(function (x) { return x.id === entry.id; });
    if (at >= 0) items[at] = entry;
    else {
      if (items.length >= MBX.QUICK_REPLY_MAX_ITEMS) { $('qr-form-msg').textContent = '항목은 ' + MBX.QUICK_REPLY_MAX_ITEMS + '개까지 둘 수 있습니다'; return; }
      items.push(entry);
    }
    await saveQuickReplies(items);
    qr.items = items;
    toast();
    selectItem(entry.id);
    runPending();
  }

  function runPending() {
    const p = qr.pending;
    qr.pending = null;
    $('qr-dirty').hidden = true;
    if (p) p();
  }

  async function onDeleteConfirmed() {
    const id = qr.editing && qr.editing.id;
    if (!id) return;
    const before = await loadQuickReplies();
    const idx = before.findIndex(function (x) { return x.id === id; });
    const items = before.filter(function (x) { return x.id !== id; });
    await saveQuickReplies(items);
    qr.items = items;
    toast('삭제했습니다');
    const next = items[Math.min(Math.max(idx, 0), items.length - 1)];
    selectItem(next ? next.id : null);
    if (next) $('qr-list').querySelector('[aria-selected="true"]').focus();
    else $('qr-new-empty').focus();
  }

  // ---- 내보내기, 가져오기(기준 문서 10-2, 10-3) ----
  async function onExport() {
    const items = await loadQuickReplies();
    const json = JSON.stringify({ version: 1, items: items }, null, 2);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = MBX.exportFileName(new Date());
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    setMsg($('qr-io-msg'), items.length + '개를 내보냈습니다', 'ok');
  }

  function hideImportPanel() {
    qr.pendingImport = null;
    $('qr-import-panel').hidden = true;
    $('qr-import-choice').hidden = true;
    $('qr-import-close-row').hidden = true;
    $('qr-import-errors').textContent = '';
    $('qr-import-file').value = '';
  }

  function showImportFailure(summary, errors) {
    $('qr-import-panel').hidden = false;
    $('qr-import-choice').hidden = true;
    $('qr-import-close-row').hidden = false;
    $('qr-import-summary').textContent = summary + ' 기존 목록은 바뀌지 않았습니다.';
    const ul = $('qr-import-errors');
    ul.textContent = '';
    errors.forEach(function (e) {
      ul.appendChild(el('li', '', (e.index >= 0 ? (e.index + 1) + '번째 항목: ' : '') + e.reason));
    });
    $('qr-import-panel').scrollIntoView({ block: 'nearest' });
  }

  function importMode() { return document.querySelector('input[name="qr-mode"]:checked').value; }

  async function updateImportCounts() {
    if (!qr.pendingImport) return;
    const mode = importMode();
    const existing = await loadQuickReplies();
    // 미리보기용이므로 id는 자리표시자로 충분하다.
    const r = MBX.mergeImport(existing, qr.pendingImport, mode, function () { return 'preview-' + Math.random(); });
    const over = r.items.length > MBX.QUICK_REPLY_MAX_ITEMS;
    $('qr-import-counts').textContent = r.added + '개 추가, ' + r.changed + '개 변경' +
      (mode === 'replace' ? ' (기존 ' + existing.length + '개는 모두 삭제됩니다)' : '') +
      (over ? ' — 합치면 ' + r.items.length + '개가 되어 한도(' + MBX.QUICK_REPLY_MAX_ITEMS + '개)를 넘습니다' : '');
    $('qr-import-counts').classList.toggle('error', over);
    const apply = $('qr-import-apply');
    apply.disabled = over;
    // 전체 교체는 되돌릴 수 없으므로 빨간 글자 버튼으로 구분한다(6-5).
    apply.className = 'btn ' + (mode === 'replace' ? 'danger' : 'pri');
    apply.textContent = mode === 'replace' ? '전체 교체 적용' : '적용';
  }

  async function onImportFile() {
    const file = $('qr-import-file').files[0];
    if (!file) return;
    setMsg($('qr-io-msg'), '');
    let parsed;
    try {
      const text = await file.text();
      // 같은 파일을 고쳐서 다시 고를 수 있도록 읽자마자 비운다(성공·실패 모두).
      $('qr-import-file').value = '';
      parsed = JSON.parse(text);
    } catch (e) {
      $('qr-import-file').value = '';
      showImportFailure('JSON으로 읽을 수 없는 파일입니다.', [{ index: -1, reason: 'JSON 문법이 올바르지 않습니다' }]);
      return;
    }
    const v = MBX.validateImport(parsed);
    if (!v.ok) { showImportFailure('가져올 수 없는 파일입니다.', v.errors); return; }
    qr.pendingImport = v.items;
    $('qr-import-panel').hidden = false;
    $('qr-import-close-row').hidden = true;
    $('qr-import-errors').textContent = '';
    $('qr-import-summary').textContent = file.name + ': ' + v.items.length + '개 항목을 읽었습니다. 적용 방식을 고르세요.';
    $('qr-import-choice').hidden = false;
    document.querySelector('input[name="qr-mode"][value="merge"]').checked = true;
    await updateImportCounts();
    $('qr-import-panel').scrollIntoView({ block: 'nearest' });
  }

  async function applyImport() {
    if (!qr.pendingImport) return;
    const existing = await loadQuickReplies();
    const mode = importMode();
    if (mode === 'replace' && !confirm('기존 빠른 메시지 ' + existing.length + '개를 모두 지우고 파일의 ' + qr.pendingImport.length + '개로 바꿀까요? 되돌릴 수 없습니다.')) return;
    const r = MBX.mergeImport(existing, qr.pendingImport, mode, newId);
    if (r.items.length > MBX.QUICK_REPLY_MAX_ITEMS) return;
    await saveQuickReplies(r.items);
    qr.items = r.items;
    hideImportPanel();
    setMsg($('qr-io-msg'), r.added + '개 추가, ' + r.changed + '개 변경했습니다', 'ok');
    toast();
    const keep = qr.editing && qr.editing.id && r.items.some(function (x) { return x.id === qr.editing.id; });
    selectItem(keep ? qr.editing.id : (r.items[0] ? r.items[0].id : null));
  }

  function initQuickReplies() {
    const list = $('qr-list');
    list.addEventListener('click', function (e) {
      const mvb = e.target.closest('[data-mv]');
      const li = e.target.closest('.qitem');
      if (!li) return;
      if (mvb) {
        e.stopPropagation();
        reorder(H.stepById(qr.items, li.dataset.id, Number(mvb.dataset.mv))).catch(function () { toast('저장하지 못했습니다'); });
        return;
      }
      if (qr.editing && qr.editing.id === li.dataset.id) return;
      const id = li.dataset.id;
      guard(function () { selectItem(id); });
    });
    list.addEventListener('keydown', function (e) {
      const li = e.target.closest('.qitem');
      if (!li || e.target !== li) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); li.click(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (e.altKey) { // Alt+화살표: 순서 바꾸기
          if (!qr.filter.trim()) reorder(H.stepById(qr.items, li.dataset.id, e.key === 'ArrowUp' ? -1 : 1)).catch(function () { toast('저장하지 못했습니다'); });
          return;
        }
        const sib = e.key === 'ArrowDown' ? li.nextElementSibling : li.previousElementSibling;
        if (sib) sib.focus();
      }
    });
    // 끌어서 순서 바꾸기(검색 중에는 끈다)
    list.addEventListener('dragstart', function (e) {
      const li = e.target.closest('.qitem');
      if (!li) return;
      qr.dragId = li.dataset.id;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', li.dataset.id);
    });
    list.addEventListener('dragover', function (e) {
      const li = e.target.closest('.qitem');
      if (!li || !qr.dragId) return;
      e.preventDefault();
      list.querySelectorAll('.drop').forEach(function (x) { x.classList.remove('drop'); });
      if (li.dataset.id !== qr.dragId) li.classList.add('drop');
    });
    list.addEventListener('dragleave', function (e) {
      const li = e.target.closest('.qitem');
      if (li) li.classList.remove('drop');
    });
    list.addEventListener('drop', function (e) {
      const li = e.target.closest('.qitem');
      e.preventDefault();
      const from = qr.dragId;
      qr.dragId = null;
      if (!li || !from) return;
      reorder(H.moveById(qr.items, from, li.dataset.id)).catch(function () { toast('저장하지 못했습니다'); });
    });
    list.addEventListener('dragend', function () {
      qr.dragId = null;
      list.querySelectorAll('.drop, .dragging').forEach(function (x) { x.classList.remove('drop', 'dragging'); });
    });

    $('qr-search').addEventListener('input', function (e) { qr.filter = e.target.value; renderList(); });
    $('qr-new').addEventListener('click', startNew);
    $('qr-new-empty').addEventListener('click', startNew);
    $('qr-form').addEventListener('submit', onSave);
    ['qr-title', 'qr-text', 'qr-tags'].forEach(function (id) {
      $(id).addEventListener('input', function () {
        if (id === 'qr-text') updateCounter();
        $(id).classList.remove('bad');
        if ($(id + '-err')) $(id + '-err').textContent = '';
        updateSaveState();
      });
    });
    $('qr-delete').addEventListener('click', function () {
      $('qr-actions').hidden = true;
      $('qr-del-confirm').hidden = false;
      $('qr-del-no').focus();
    });
    $('qr-del-no').addEventListener('click', function () {
      $('qr-del-confirm').hidden = true;
      $('qr-actions').hidden = false;
      $('qr-delete').focus();
    });
    $('qr-del-yes').addEventListener('click', function () { onDeleteConfirmed().catch(function () { toast('삭제하지 못했습니다'); }); });
    $('qr-cancel-new').addEventListener('click', function () {
      guard(function () { selectItem(qr.items[0] ? qr.items[0].id : null); });
    });
    $('qr-discard').addEventListener('click', function () {
      // 편집 내용을 저장된 값으로 되돌린 뒤 미뤄 둔 이동을 한다.
      if (qr.editing && !qr.editing.id) qr.editing = qr.items[0] ? { id: qr.items[0].id } : null;
      renderEditor();
      renderList();
      runPending();
    });
    $('qr-stay').addEventListener('click', function () {
      qr.pending = null;
      $('qr-dirty').hidden = true;
      $('qr-title').focus();
    });

    $('qr-export').addEventListener('click', function () { onExport().catch(function () { setMsg($('qr-io-msg'), '내보내지 못했습니다', 'error'); }); });
    $('qr-import-btn').addEventListener('click', function () { $('qr-import-file').click(); });
    $('qr-import-file').addEventListener('change', onImportFile);
    document.querySelectorAll('input[name="qr-mode"]').forEach(function (r) { r.addEventListener('change', updateImportCounts); });
    $('qr-import-apply').addEventListener('click', function () { guard(function () { applyImport().catch(function () { setMsg($('qr-io-msg'), '가져오지 못했습니다', 'error'); }); }); });
    $('qr-import-cancel').addEventListener('click', hideImportPanel);
    $('qr-import-close').addEventListener('click', hideImportPanel);

    // 다른 탭에서 바뀌어도 목록을 맞춘다(편집 중인 내용은 건드리지 않는다).
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes.quickReplies) reloadItems().catch(function () { console.debug('quick replies reload failed'); });
    });
    window.addEventListener('beforeunload', function (e) {
      if (qr.dirty()) { e.preventDefault(); e.returnValue = ''; }
    });

    return loadQuickReplies().then(function (items) {
      qr.items = items;
      qr.editing = items.length ? { id: items[0].id } : null;
      renderList();
      renderEditor();
    });
  }

  function initVersion() {
    let v = '';
    try { v = chrome.runtime.getManifest().version; } catch (e) { console.debug('manifest read failed'); }
    $('ver-top').textContent = v;
    $('ver-help').textContent = 'Meta Inbox Helper ' + v;
  }

  self.MBX_OPTIONS = { loadSettings: loadSettings, saveSettings: saveSettings };

  async function init() {
    initVersion();
    initNavigation();
    initPendingSection();
    const pending = await takePendingSection();
    showSection(pending && H.isSection(pending) ? pending : H.sectionFromHash(location.hash), { replace: true, initial: true });
    initQuickReplies().catch(function () { console.debug('quick replies init failed'); });
    initDeeplCheck();
    initSlackTest();
    initSetAsset();
    initPermissions();
    initStatus();
    initSettings().catch(function () { console.debug('settings init failed'); });
  }

  if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.storage) {
    init().catch(function () { console.debug('options init failed'); });
  }
})();
