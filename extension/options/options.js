// options 페이지는 신뢰 영역이므로 chrome.storage.local을 직접 읽고 쓴다.
(function () {
  const MBX = self.MBX;
  const $ = function (id) { return document.getElementById(id); };

  const SEND_LANGS = MBX.SEND_LANGS;
  const BUBBLE_LANGS = [['KO', '한국어']].concat(SEND_LANGS);

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

  function setMsg(el, text, isError) {
    el.textContent = text || '';
    el.classList.toggle('error', !!isError);
  }

  function newId() {
    return (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'qr-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }

  // ---- 빠른 메시지 ----
  let editingId = null;
  let pendingImport = null;

  function parseTags(s) {
    return s.split(',').map(function (t) { return t.trim(); }).filter(Boolean);
  }

  function button(label, onClick, disabled) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.disabled = !!disabled;
    b.addEventListener('click', onClick);
    return b;
  }

  async function renderQuickReplies() {
    const items = await loadQuickReplies();
    const ul = $('qr-list');
    ul.textContent = '';
    $('qr-empty').hidden = items.length > 0;
    items.forEach(function (it, i) {
      const li = document.createElement('li');
      const body = document.createElement('div');
      body.className = 'qr-body';
      const t = document.createElement('div');
      t.className = 'qr-title';
      t.textContent = it.title + (it.tags && it.tags.length ? '  #' + it.tags.join(' #') : '');
      const p = document.createElement('div');
      p.className = 'qr-preview';
      p.textContent = it.text;
      body.appendChild(t);
      body.appendChild(p);
      li.appendChild(body);
      li.appendChild(button('위', function () { move(i, -1); }, i === 0));
      li.appendChild(button('아래', function () { move(i, 1); }, i === items.length - 1));
      li.appendChild(button('수정', function () { startEdit(it); }));
      li.appendChild(button('삭제', function () { remove(it); }));
      ul.appendChild(li);
    });
  }

  async function move(i, delta) {
    const items = await loadQuickReplies();
    const j = i + delta;
    if (j < 0 || j >= items.length) return;
    const tmp = items[i]; items[i] = items[j]; items[j] = tmp;
    await saveQuickReplies(items);
    await renderQuickReplies();
  }

  async function remove(it) {
    if (!confirm('"' + it.title + '" 항목을 삭제할까요?')) return;
    const items = (await loadQuickReplies()).filter(function (x) { return x.id !== it.id; });
    await saveQuickReplies(items);
    if (editingId === it.id) resetForm();
    await renderQuickReplies();
  }

  function startEdit(it) {
    editingId = it.id;
    $('qr-title').value = it.title;
    $('qr-text').value = it.text;
    $('qr-tags').value = (it.tags || []).join(', ');
    $('qr-form-title').textContent = '빠른 메시지 수정';
    $('qr-save').textContent = '저장';
    $('qr-cancel').hidden = false;
    setMsg($('qr-form-msg'), '');
    $('qr-title').focus();
  }

  function resetForm() {
    editingId = null;
    $('qr-form').reset();
    $('qr-form-title').textContent = '새 빠른 메시지';
    $('qr-save').textContent = '추가';
    $('qr-cancel').hidden = true;
  }

  async function onSubmitForm(e) {
    e.preventDefault();
    const entry = { id: editingId || newId(), title: $('qr-title').value, text: $('qr-text').value, tags: parseTags($('qr-tags').value) };
    const v = MBX.validateImport([entry]);
    if (!v.ok) { setMsg($('qr-form-msg'), v.errors[0].reason, true); return; }
    const items = await loadQuickReplies();
    const at = items.findIndex(function (x) { return x.id === entry.id; });
    if (at >= 0) items[at] = entry;
    else {
      if (items.length >= MBX.QUICK_REPLY_MAX_ITEMS) { setMsg($('qr-form-msg'), '항목은 ' + MBX.QUICK_REPLY_MAX_ITEMS + '개까지 둘 수 있습니다', true); return; }
      items.push(entry);
    }
    await saveQuickReplies(items);
    resetForm();
    setMsg($('qr-form-msg'), '저장했습니다');
    await renderQuickReplies();
  }

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
    setMsg($('qr-io-msg'), items.length + '개를 내보냈습니다');
  }

  function hideImportPanel() {
    pendingImport = null;
    $('qr-import-panel').hidden = true;
    $('qr-import-choice').hidden = true;
    $('qr-import-errors').textContent = '';
    $('qr-import-file').value = '';
  }

  function showImportFailure(summary, errors) {
    $('qr-import-panel').hidden = false;
    $('qr-import-choice').hidden = true;
    $('qr-import-summary').textContent = summary + ' 기존 목록은 바뀌지 않았습니다.';
    const ul = $('qr-import-errors');
    ul.textContent = '';
    errors.forEach(function (e) {
      const li = document.createElement('li');
      li.textContent = (e.index >= 0 ? (e.index + 1) + '번째 항목: ' : '') + e.reason;
      ul.appendChild(li);
    });
  }

  async function updateImportCounts() {
    if (!pendingImport) return;
    const mode = document.querySelector('input[name="qr-mode"]:checked').value;
    const existing = await loadQuickReplies();
    // 미리보기용이므로 id는 자리표시자로 충분하다.
    const r = MBX.mergeImport(existing, pendingImport, mode, function () { return 'preview-' + Math.random(); });
    pendingImport.result = r;
    pendingImport.mode = mode;
    const over = r.items.length > MBX.QUICK_REPLY_MAX_ITEMS;
    $('qr-import-counts').textContent = r.added + '개 추가, ' + r.changed + '개 변경' +
      (mode === 'replace' ? ' (기존 ' + existing.length + '개는 모두 삭제됩니다)' : '') +
      (over ? ' — 합치면 ' + r.items.length + '개가 되어 한도(' + MBX.QUICK_REPLY_MAX_ITEMS + '개)를 넘습니다' : '');
    $('qr-import-apply').disabled = over;
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
    pendingImport = v.items;
    $('qr-import-panel').hidden = false;
    $('qr-import-errors').textContent = '';
    $('qr-import-summary').textContent = file.name + ': ' + v.items.length + '개 항목을 읽었습니다. 적용 방식을 고르세요.';
    $('qr-import-choice').hidden = false;
    await updateImportCounts();
  }

  async function onImportApply() {
    if (!pendingImport) return;
    const existing = await loadQuickReplies();
    const mode = document.querySelector('input[name="qr-mode"]:checked').value;
    const r = MBX.mergeImport(existing, pendingImport, mode, newId);
    if (r.items.length > MBX.QUICK_REPLY_MAX_ITEMS) return;
    await saveQuickReplies(r.items);
    hideImportPanel();
    resetForm();
    setMsg($('qr-io-msg'), r.added + '개 추가, ' + r.changed + '개 변경했습니다');
    await renderQuickReplies();
  }

  function initQuickReplies() {
    $('qr-form').addEventListener('submit', onSubmitForm);
    $('qr-cancel').addEventListener('click', function () { resetForm(); setMsg($('qr-form-msg'), ''); });
    $('qr-export').addEventListener('click', onExport);
    $('qr-import-btn').addEventListener('click', function () { $('qr-import-file').click(); });
    $('qr-import-file').addEventListener('change', onImportFile);
    document.querySelectorAll('input[name="qr-mode"]').forEach(function (r) { r.addEventListener('change', updateImportCounts); });
    $('qr-import-apply').addEventListener('click', onImportApply);
    $('qr-import-cancel').addEventListener('click', hideImportPanel);
    return renderQuickReplies();
  }

  // ---- 일반 설정 ----
  function fillSelect(sel, options, value) {
    sel.textContent = '';
    options.forEach(function (o) {
      const opt = document.createElement('option');
      opt.value = o[0];
      opt.textContent = o[0] + ' · ' + o[1];
      sel.appendChild(opt);
    });
    sel.value = value;
  }

  function maskedWebhook(url) { return url ? 'https://hooks.slack.com/' + '•'.repeat(12) : ''; }
  function maskedKey(key) { return key ? '•'.repeat(16) + (/:fx$/.test(key) ? ' (:fx)' : '') : ''; }

  // 비밀값 입력칸: 저장돼 있으면 가린 표시와 [변경]만 보이고, 입력칸에는 값을 다시 채우지 않는다.
  function renderSecret(prefix, value, mask) {
    const has = !!value;
    $(prefix + '-masked').hidden = !has;
    $(prefix + '-form').hidden = has;
    $(prefix + '-masked-text').textContent = mask(value);
    $(prefix + '-input').value = '';
  }

  function renderDeeplWarning(key) {
    $('deepl-free-warning').hidden = !/:fx$/.test(key || '');
  }

  function bindToggle(key) {
    $(key).addEventListener('change', function (e) { saveSettings({ [key]: e.target.checked }); });
  }

  async function initSettings() {
    const s = await loadSettings();
    ['slackEnabled', 'slackMaskPhone', 'bubbleButtonsEnabled', 'sendTranslateEnabled', 'quickRepliesEnabled'].forEach(function (k) {
      $(k).checked = !!s[k];
      bindToggle(k);
    });
    $('slackPreviewMaxLen').value = s.slackPreviewMaxLen;
    $('slackPreviewMaxLen').addEventListener('change', function (e) {
      const n = Math.floor(Number(e.target.value));
      const ok = Number.isFinite(n) && n >= 1 && n <= 1000;
      const value = ok ? n : MBX.DEFAULT_SETTINGS.slackPreviewMaxLen;
      e.target.value = value;
      saveSettings({ slackPreviewMaxLen: value });
    });
    $('accountName').value = s.accountName;
    $('accountName').addEventListener('change', function (e) { saveSettings({ accountName: e.target.value.trim() }); });
    $('asset-current').textContent = s.assetId || '(없음)';

    fillSelect($('bubbleTargetLang'), BUBBLE_LANGS, s.bubbleTargetLang);
    fillSelect($('sendTargetLang'), SEND_LANGS, s.sendTargetLang);
    $('bubbleTargetLang').addEventListener('change', function (e) { saveSettings({ bubbleTargetLang: e.target.value }); });
    $('sendTargetLang').addEventListener('change', function (e) { saveSettings({ sendTargetLang: e.target.value }); });

    renderSecret('webhook', s.slackWebhookUrl, maskedWebhook);
    $('webhook-change').addEventListener('click', function () {
      $('webhook-masked').hidden = true;
      $('webhook-form').hidden = false;
      $('webhook-input').focus();
    });
    $('webhook-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      const url = $('webhook-input').value.trim();
      const v = MBX.validateWebhookUrl(url);
      if (!v.ok) { setMsg($('webhook-msg'), v.reason, true); return; }
      await saveSettings({ slackWebhookUrl: url });
      renderSecret('webhook', url, maskedWebhook);
      setMsg($('webhook-msg'), url ? '저장했습니다' : 'Webhook 주소를 지웠습니다');
    });

    renderSecret('deepl', s.deeplApiKey, maskedKey);
    renderDeeplWarning(s.deeplApiKey);
    $('deepl-change').addEventListener('click', function () {
      $('deepl-masked').hidden = true;
      $('deepl-form').hidden = false;
      $('deepl-input').focus();
    });
    $('deepl-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      const key = $('deepl-input').value.trim();
      await saveSettings({ deeplApiKey: key });
      renderSecret('deepl', key, maskedKey);
      renderDeeplWarning(key);
      setMsg($('deepl-msg'), key ? '저장했습니다' : 'DeepL 키를 지웠습니다');
    });
  }

  function initDeeplCheck() {
    $('btn-check-deepl').addEventListener('click', async function () {
      const out = $('deepl-check-result');
      const btn = $('btn-check-deepl');
      btn.disabled = true;
      setMsg(out, '확인 중...');
      try {
        const r = await chrome.runtime.sendMessage({ type: 'CHECK_DEEPL_KEY' });
        if (r && r.ok) setMsg(out, '사용량 ' + Number(r.used).toLocaleString() + ' / ' + Number(r.limit).toLocaleString() + '자');
        else setMsg(out, (r && r.message) || '확인하지 못했습니다', true);
      } catch (e) {
        setMsg(out, '확인하지 못했습니다', true);
      } finally {
        btn.disabled = false;
      }
    });
  }

  // 테스트 메시지: service worker 가 대기열에 넣고 바로 보낸 결과를 돌려받는다.
  function initSlackTest() {
    const btn = $('btn-test-slack');
    btn.disabled = false;
    btn.removeAttribute('title');
    btn.addEventListener('click', async function () {
      const out = $('test-slack-result');
      btn.disabled = true;
      setMsg(out, '보내는 중...');
      try {
        const r = await chrome.runtime.sendMessage({ type: 'SEND_TEST_SLACK' });
        if (r && r.ok) setMsg(out, 'Slack으로 보냈습니다');
        else setMsg(out, (r && r.message) || '보내지 못했습니다', true);
      } catch (e) {
        setMsg(out, '보내지 못했습니다', true);
      } finally {
        btn.disabled = false;
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
      box.appendChild(button(id, function () { requestSetAsset(id); }));
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
        setMsg(out, '알림 대상으로 지정했습니다');
      } else if (r && r.code === 'NO_INBOX_TAB') {
        renderAssetChoices(null);
        setMsg(out, '수신함을 먼저 여세요', true);
      } else if (r && r.code === 'MULTIPLE') {
        renderAssetChoices(r.assetIds);
        setMsg(out, '열려 있는 수신함의 계정이 여러 개입니다. 알림 대상을 고르세요');
      } else {
        setMsg(out, '지정하지 못했습니다. 수신함 탭을 새로고침한 뒤 다시 시도하세요', true);
      }
    } catch (e) {
      setMsg(out, '지정하지 못했습니다', true);
    } finally {
      btn.disabled = false;
      renderStatus().catch(function () { console.debug('status render failed'); });
    }
  }

  function initSetAsset() {
    const btn = $('btn-set-asset');
    btn.disabled = false;
    btn.removeAttribute('title');
    btn.addEventListener('click', function () { requestSetAsset(null); });
  }

  // ---- 상태 영역 ----
  // GET_STATUS 결과를 그리고 5초마다 갱신한다. 최근 오류는 저장소가 바뀔 때도 다시 그린다.
  const STATUS_REFRESH_MS = 5000;

  function fmtTime(at) { return at ? new Date(at).toLocaleString() : ''; }

  function sendText(s) {
    if (!s) return '-';
    const what = s.outcome === 'ok' ? '성공' : s.outcome === 'retry' ? '실패, 재시도 예정' : '설정 오류';
    return fmtTime(s.at) + ' ' + what + (s.status ? ' (HTTP ' + s.status + ')' : s.outcome === 'ok' ? '' : ' (네트워크 오류)');
  }

  async function renderStatus() {
    const r = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    if (!r || r.ok === false) return;
    setMsg($('status-heartbeat'), r.lastHeartbeat ? fmtTime(r.lastHeartbeat) : '아직 받지 않음');
    setMsg($('status-owner'), !r.assetId ? '알림 대상 계정이 지정되지 않았습니다'
      : r.ownerTabId !== null ? '있음 (탭 ' + r.ownerTabId + ')' : '없음: 대상 계정의 수신함 탭을 여세요', !r.assetId || r.ownerTabId === null);
    setMsg($('status-slack'), sendText(r.lastSend), !!r.lastSend && r.lastSend.outcome !== 'ok');
    setMsg($('status-queue'), String(r.queueLength));
    const e = r.lastError;
    setMsg($('status-error'), e ? (e.at ? fmtTime(e.at) + ' ' : '') + (e.message || e.code || '오류') : '-', !!e);
    $('asset-current').textContent = r.assetId || '(없음)';
  }

  function initStatus() {
    const tick = function () { renderStatus().catch(function () { console.debug('status render failed'); }); };
    tick();
    setInterval(tick, STATUS_REFRESH_MS);
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && (changes.lastError || changes.settings)) tick();
    });
  }

  self.MBX_OPTIONS = { loadSettings: loadSettings, saveSettings: saveSettings };

  if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.storage) {
    initQuickReplies().catch(function () { console.debug('quick replies init failed'); });
    initDeeplCheck();
    initSlackTest();
    initSetAsset();
    initStatus();
    initSettings().catch(function () { console.debug('settings init failed'); });
  }
})();
