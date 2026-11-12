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

  root.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  root.SECRET_KEYS = SECRET_KEYS;
  root.publicSettings = publicSettings;
  root.classifySender = classifySender;
  root.isAllowed = isAllowed;
})(typeof module !== 'undefined' && module.exports ? module.exports : (self.MBX = self.MBX || {}));
