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
    if (sender.tab) {
      const url = sender.tab.url;
      return typeof url === 'string' && url.indexOf('https://business.facebook.com/') === 0 ? 'content' : 'reject';
    }
    const optionsUrl = 'chrome-extension://' + extensionId + '/options/options.html';
    if (typeof sender.url === 'string' && (sender.url === optionsUrl || sender.url.indexOf(optionsUrl + '?') === 0 || sender.url.indexOf(optionsUrl + '#') === 0)) return 'options';
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
