(function (root) {
  const DEFAULT_SETTINGS = {
    slackEnabled: true,
    slackWebhookUrl: '',
    assetId: '',
    accountName: '',
    slackPreviewMaxLen: 100,
    slackMaskPhone: true,
    deeplApiKey: '',
    bubbleTargetLang: 'KO',
    sendTranslateEnabled: true,
    sendTargetLang: 'EN-US',
    bubbleButtonsEnabled: true,
    quickRepliesEnabled: true
  };

  const SECRET_KEYS = ['slackWebhookUrl', 'deeplApiKey'];

  const CONTENT_TYPES = ['GET_PUBLIC_SETTINGS', 'BADGE_STATE', 'LIST_CANDIDATE', 'SET_THREAD_LANG',
    'GET_THREAD_LANG', 'HEARTBEAT', 'HELLO', 'TRANSLATE', 'OPEN_OPTIONS'];
  const OPTIONS_TYPES = ['SEND_TEST_SLACK', 'CHECK_DEEPL_KEY', 'GET_STATUS', 'SET_ASSET_FROM_OPEN_TAB'];
  const BOTH_TYPES = ['GET_QUICK_REPLIES'];

  function publicSettings(settings) {
    const copy = Object.assign({}, settings);
    SECRET_KEYS.forEach(function (k) { delete copy[k]; });
    return copy;
  }

  function classifySender(sender, extensionId) {
    if (!sender || !extensionId || sender.id !== extensionId) return 'reject';
    const optionsUrl = 'chrome-extension://' + extensionId + '/options/options.html';
    const u = sender.url;
    // open_in_tab 이면 options 페이지 메시지에도 sender.tab 이 붙으므로 먼저 판정한다.
    if (typeof u === 'string' && (u === optionsUrl || u.indexOf(optionsUrl + '?') === 0 || u.indexOf(optionsUrl + '#') === 0)) return 'options';
    if (sender.tab && typeof sender.tab.url === 'string' && sender.tab.url.indexOf('https://business.facebook.com/') === 0) return 'content';
    return 'reject';
  }

  function isAllowed(type, senderKind) {
    if (BOTH_TYPES.indexOf(type) >= 0) return senderKind === 'content' || senderKind === 'options';
    if (senderKind === 'content') return CONTENT_TYPES.indexOf(type) >= 0;
    if (senderKind === 'options') return OPTIONS_TYPES.indexOf(type) >= 0;
    return false;
  }

  // 빈 문자열은 "설정 안 함"이므로 허용한다. 그 외에는 host 권한이 있는 Slack 주소만 받는다.
  function validateWebhookUrl(url) {
    if (url === '') return { ok: true };
    if (typeof url !== 'string' || url.indexOf('https://hooks.slack.com/') !== 0) {
      return { ok: false, reason: 'https://hooks.slack.com/ 으로 시작하는 주소만 쓸 수 있습니다' };
    }
    if (url.slice('https://hooks.slack.com/'.length).length === 0) return { ok: false, reason: '주소가 완전하지 않습니다' };
    return { ok: true };
  }

  // HELLO 응답의 role. 담당 지정(owner)은 이후 Task에서 한다.
  function roleFor(settings, assetId) {
    const configured = settings && typeof settings.assetId === 'string' ? settings.assetId.trim() : '';
    if (!configured) return 'not_configured';
    return configured === assetId ? 'standby' : 'other_account';
  }

  // service worker 의 BADGE_STATE·LIST_CANDIDATE 계정 검사. 설정 assetId가 비어 있지 않고 보고의 asset_id와 같을 때만 참.
  function assetMatches(settings, msg) {
    const target = settings && typeof settings.assetId === 'string' ? settings.assetId.trim() : '';
    return !!target && !!msg && typeof msg.asset_id === 'string' && msg.asset_id === target;
  }

  root.assetMatches = assetMatches;
  root.roleFor = roleFor;
  root.validateWebhookUrl = validateWebhookUrl;
  root.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  root.SECRET_KEYS = SECRET_KEYS;
  root.publicSettings = publicSettings;
  root.classifySender = classifySender;
  root.isAllowed = isAllowed;
})(typeof module !== 'undefined' && module.exports ? module.exports : (self.MBX = self.MBX || {}));
