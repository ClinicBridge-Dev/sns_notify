(function (root) {
  const C = {
    DROP_WAIT_MS: 3000,
    HOLD_MS: 5000,
    SUPPLEMENT_WINDOW_MS: 120000,
    DEDUP_MS: 600000,
    QUEUE_TTL_MS: 86400000,
    SENT_KEY_TTL_MS: 86400000,
    RETRY_DELAYS_MS: [30000, 120000, 600000], // 이후 600000 반복
    HEARTBEAT_MS: 30000,
    OWNER_TIMEOUT_MS: 90000,
    STOP_AFTER_MS: 180000,
    SLEEP_GAP_MS: 180000,
    SETTLE_LOAD_MS: 20000,
    SETTLE_CHANGE_MS: 3000,
    LIST_TOP_N: 15,
    KNOWN_CAP: 500,
    CANDIDATE_MAX: 3,
    LIST_DEBOUNCE_MS: 1500, // 탭이 보일 때만
    SEND_PENDING_MS: 500,
    BYPASS_MS: 1000,
    SEND_CONFIRM_MS: 1500,
    DEEPL_TIMEOUT_MS: 10000,
    TRANSLATE_MAX_CHARS: 5000,
    THREAD_LANG_CAP: 500,
    THREAD_LANG_RETRY_MS: 500,
    QUICK_REPLY_MAX_ITEMS: 500,
    QUICK_REPLY_MAX_TITLE: 50,
    QUICK_REPLY_MAX_TEXT: 2000
  };
  // 번역 대상 언어(기획서 5장). background 검증, options, composer가 함께 쓴다.
  const SEND_LANGS = [
    ['EN-US', '영어 (미국)'], ['EN-GB', '영어 (영국)'], ['ZH-HANS', '중국어 (간체)'], ['ZH-HANT', '중국어 (번체)'],
    ['JA', '일본어'], ['ES', '스페인어'], ['FR', '프랑스어'], ['DE', '독일어'], ['RU', '러시아어'],
    ['VI', '베트남어'], ['TH', '태국어'], ['ID', '인도네시아어'], ['AR', '아랍어'], ['PT-BR', '포르투갈어 (브라질)']
  ];
  root.SEND_LANGS = SEND_LANGS;
  root.isValidThreadLang = function (l) {
    return l === 'OFF' || SEND_LANGS.some(function (x) { return x[0] === l; });
  };
  Object.keys(C).forEach(function (k) { root[k] = C[k]; });
  root.CONSTANTS = C;
})(typeof module !== 'undefined' && module.exports ? module.exports : (self.MBX = self.MBX || {}));
