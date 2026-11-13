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
    QUICK_REPLY_MAX_TEXT: 2000,
    HIDDEN_TAB_DOUBLE_OBSERVE: true // 가려진 탭: 연속 두 번의 관찰에서 동일할 때만 후보(Task 9, U12 미확인)
  };
  // 번역 대상 언어(기획서 5장). background 검증, options, composer가 함께 쓴다.
  const SEND_LANGS = [
    ['EN-US', '영어 (미국)'], ['EN-GB', '영어 (영국)'], ['ZH-HANS', '중국어 (간체)'], ['ZH-HANT', '중국어 (번체)'],
    ['JA', '일본어'], ['ES', '스페인어'], ['FR', '프랑스어'], ['DE', '독일어'], ['RU', '러시아어'],
    ['VI', '베트남어'], ['TH', '태국어'], ['ID', '인도네시아어'], ['AR', '아랍어'], ['PT-BR', '포르투갈어 (브라질)']
  ];
  // 언어 코드 → 한국어 이름(UI 수정 기획서 3-4). 액션 줄, 도구 막대, 설정 화면이 함께 쓴다.
  // 보낼 때 쓰는 대상 언어(SEND_LANGS)와 DeepL이 감지해 돌려주는 원문 언어 코드를 모두 담는다.
  const LANG_NAMES = {
    KO: '한국어', JA: '일본어', EN: '영어', 'EN-US': '영어 (미국)', 'EN-GB': '영어 (영국)',
    ZH: '중국어', 'ZH-HANS': '중국어 (간체)', 'ZH-HANT': '중국어 (번체)',
    ES: '스페인어', FR: '프랑스어', DE: '독일어', RU: '러시아어', VI: '베트남어', TH: '태국어', ID: '인도네시아어',
    AR: '아랍어', PT: '포르투갈어', 'PT-BR': '포르투갈어 (브라질)', 'PT-PT': '포르투갈어 (포르투갈)',
    IT: '이탈리아어', NL: '네덜란드어', PL: '폴란드어', TR: '튀르키예어', UK: '우크라이나어',
    BG: '불가리아어', CS: '체코어', DA: '덴마크어', EL: '그리스어', ET: '에스토니아어', FI: '핀란드어',
    HE: '히브리어', HU: '헝가리어', LT: '리투아니아어', LV: '라트비아어', NB: '노르웨이어', RO: '루마니아어',
    SK: '슬로바키아어', SL: '슬로베니아어', SV: '스웨덴어'
  };
  // 이름표에 없는 코드는 코드를 그대로 돌려준다.
  root.langName = function (code) {
    if (typeof code !== 'string' || !code) return '';
    const k = code.toUpperCase();
    return Object.prototype.hasOwnProperty.call(LANG_NAMES, k) ? LANG_NAMES[k] : code;
  };
  // 언어 코드의 앞부분으로 비교한다(EN과 EN-US는 같은 언어).
  root.sameLanguage = function (a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    return a.split('-')[0].toUpperCase() === b.split('-')[0].toUpperCase();
  };
  root.LANG_NAMES = LANG_NAMES;
  root.SEND_LANGS = SEND_LANGS;
  // 대화별 번역 언어로 저장할 수 있는 값. 언어 코드만 받는다('OFF'는 on: false로 대신한다, UI 수정 기획서 4-4).
  root.isValidThreadLang = function (l) {
    return SEND_LANGS.some(function (x) { return x[0] === l; });
  };
  Object.keys(C).forEach(function (k) { root[k] = C[k]; });
  root.CONSTANTS = C;
})(typeof module !== 'undefined' && module.exports ? module.exports : (self.MBX = self.MBX || {}));
