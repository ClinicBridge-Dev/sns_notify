// 대화별 번역 대상 언어 저장 한도 관리(순수 로직). 값은 { lang, at }.
(function (root) {
  function validEntry(e) {
    return !!e && typeof e === 'object' && typeof e.lang === 'string' && e.lang !== '';
  }

  function getThreadLang(map, threadId, fallback) {
    const e = map && typeof map === 'object' && Object.prototype.hasOwnProperty.call(map, threadId) ? map[threadId] : null;
    return validEntry(e) ? e.lang : fallback;
  }

  // 새 map을 돌려준다(입력은 바꾸지 않는다). cap을 넘으면 at이 오래된 것부터 지운다.
  function setThreadLang(map, threadId, lang, now, cap) {
    const next = {};
    const src = map && typeof map === 'object' ? map : {};
    Object.keys(src).forEach(function (k) { if (validEntry(src[k])) next[k] = src[k]; });
    next[threadId] = { lang: lang, at: now };
    const keys = Object.keys(next);
    if (keys.length > cap) {
      keys.sort(function (a, b) { return next[a].at - next[b].at; });
      keys.slice(0, keys.length - cap).forEach(function (k) { delete next[k]; });
    }
    return next;
  }

  root.setThreadLang = setThreadLang;
  root.getThreadLang = getThreadLang;
})(typeof module !== 'undefined' && module.exports ? module.exports : (self.MBX = self.MBX || {}));
