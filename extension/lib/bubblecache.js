// 말풍선 번역의 순수 로직: 200개 FIFO 캐시, 오류 코드별 문구, 언어 표시.
(function (root) {
  const BUBBLE_CACHE_MAX = 200;

  // 가장 먼저 넣은 것부터 지운다(읽어도 순서는 바뀌지 않는다). 같은 키를 다시 넣으면 값만 바꾼다.
  function createFifoCache(max) {
    const limit = max || BUBBLE_CACHE_MAX;
    const m = new Map();
    return {
      get: function (k) { return m.get(k); },
      has: function (k) { return m.has(k); },
      set: function (k, v) {
        if (!m.has(k) && m.size >= limit) m.delete(m.keys().next().value);
        m.set(k, v);
      },
      size: function () { return m.size; }
    };
  }

  // 기획서 7-3 오류 표. 알 수 없는 코드는 응답의 message, 그것도 없으면 재시도 안내.
  const TEXT = {
    NO_KEY: 'DeepL 키를 설정하세요',
    BAD_KEY: 'DeepL 키가 올바르지 않습니다',
    QUOTA: 'DeepL 사용 한도를 초과했습니다',
    RETRY: '잠시 후 다시 시도하세요',
    TOO_LONG: '번역할 수 있는 길이(5000자)를 넘었습니다',
    DISCONNECTED: '확장 프로그램이 갱신되었습니다. 페이지를 새로고침하세요'
  };

  function bubbleErrorText(res) {
    const code = res && res.code;
    if (code && Object.prototype.hasOwnProperty.call(TEXT, code)) return TEXT[code];
    if (res && typeof res.message === 'string' && res.message) return res.message;
    return TEXT.RETRY;
  }

  // "EN → KO". 감지 언어가 없으면 목표 언어만.
  function langPair(detected, target) {
    const d = typeof detected === 'string' && detected ? detected.toUpperCase() : '';
    const t = typeof target === 'string' ? target.toUpperCase() : '';
    return d ? d + ' → ' + t : t;
  }

  root.BUBBLE_CACHE_MAX = BUBBLE_CACHE_MAX;
  root.createFifoCache = createFifoCache;
  root.bubbleErrorText = bubbleErrorText;
  root.langPair = langPair;
})(typeof module !== 'undefined' && module.exports ? module.exports : (self.MBX = self.MBX || {}));
