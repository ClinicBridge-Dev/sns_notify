// 대화별 번역 상태 저장(순수 로직). 저장 값은 { lang, on, at } (UI 수정 기획서 4-4).
// 예전 값 { lang, at }과 { lang: 'OFF', at }도 그대로 남아 있을 수 있다. 저장된 값을 한꺼번에 고쳐 쓰지 않고
// 읽을 때 getThreadLang 한 곳에서 변환하며, 다음에 그 대화를 저장할 때 새 형태로 쓴다.
// 원칙: 저장된 값에서 꺼짐(on: false 또는 'OFF')을 읽을 수 있으면 결과는 반드시 꺼짐이다.
(function (root) {
  function isObj(e) { return !!e && typeof e === 'object'; }

  // 정리(cap 초과 삭제) 때 남길 항목. 꺼짐으로 읽히는 항목은 언어가 잘못돼도 남긴다(지우면 켜짐으로 읽힌다).
  function validEntry(e) {
    if (typeof e === 'string') return e !== '';
    return isObj(e) && ((typeof e.lang === 'string' && e.lang !== '') || e.on === false);
  }

  function ageOf(e) { return isObj(e) && typeof e.at === 'number' ? e.at : 0; }

  // 돌려주는 값은 항상 { lang: 유효한 언어 코드, on: 불리언 }. 변환 표는 기획서 4-4를 위에서부터 적용한다.
  function getThreadLang(map, threadId, defaultLang, isValidLang) {
    const valid = function (l) { return typeof l === 'string' && l !== 'OFF' && !!isValidLang(l); };
    const e = isObj(map) && Object.prototype.hasOwnProperty.call(map, threadId) ? map[threadId] : undefined;
    if (isObj(e)) {
      if (e.lang === 'OFF' || e.on === false) return { lang: valid(e.lang) ? e.lang : defaultLang, on: false };
      if (valid(e.lang) && (e.on === true || e.on === undefined)) return { lang: e.lang, on: true };
    } else if (e === 'OFF') {
      return { lang: defaultLang, on: false };
    } else if (valid(e)) {
      return { lang: e, on: true };
    }
    return { lang: defaultLang, on: true };
  }

  // 새 map을 돌려준다(입력은 바꾸지 않는다). cap을 넘으면 at이 오래된 것부터 지운다.
  function setThreadLang(map, threadId, lang, on, now, cap) {
    const next = {};
    const src = isObj(map) ? map : {};
    Object.keys(src).forEach(function (k) { if (validEntry(src[k])) next[k] = src[k]; });
    next[threadId] = { lang: lang, on: on, at: now };
    const keys = Object.keys(next);
    if (keys.length > cap) {
      keys.sort(function (a, b) { return ageOf(next[a]) - ageOf(next[b]); });
      keys.slice(0, keys.length - cap).forEach(function (k) { delete next[k]; });
    }
    return next;
  }

  root.setThreadLang = setThreadLang;
  root.getThreadLang = getThreadLang;
})(typeof module !== 'undefined' && module.exports ? module.exports : (self.MBX = self.MBX || {}));
