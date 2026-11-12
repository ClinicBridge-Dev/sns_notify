// R5 전송 가로채기의 순수 판단(기획서 8-2, 8-3). 브라우저(content script)와 node 테스트 양쪽에서 로드한다.
// 원칙: 실패하면 전송하지 않는다.
(function (root) {
  const HANGUL = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;

  function hasHangul(s) {
    return typeof s === 'string' && HANGUL.test(s);
  }

  // 판정 순서는 계획서 Task 13 Step 3의 ①~⑩ 그대로다. 순서를 바꾸지 않는다.
  function decideSend(ctx) {
    if (ctx.bypass) return 'pass';                       // ① 확장이 이어서 실행한 전송
    if (ctx.busy) return 'swallow';                      // ② 번역 처리 중: Meta에 넘기지 않는다
    if (!hasHangul(ctx.text)) return 'pass';             // ③ 한글 없음
    if (!ctx.settingsLoaded) return 'block_loading';     // ④ 설정을 아직 받지 못함
    if (!ctx.enabled) return 'pass';                     // ⑤ 번역 전송 꺼짐
    if (!ctx.langLoaded) return 'block_loading';         // ⑥ 대화별 언어를 아직 받지 못함
    if (ctx.lang === 'OFF') return 'pass';               // ⑦ 이 대화는 번역 끔
    if (ctx.lastTranslated !== null && ctx.lastTranslated !== undefined &&
        ctx.text === ctx.lastTranslated) return 'pass';  // ⑧ 직전 번역 결과 그대로 다시 누름
    if (!ctx.connected) return 'block_disconnected';     // ⑨ 확장 연결 끊김
    return 'intercept';                                  // ⑩
  }

  // Windows에서는 조합 중 keydown의 key가 'Process'로 오므로 code도 본다.
  function isEnterKey(e) {
    return !!e && (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter');
  }

  // 포커스된 버튼을 실행하는 키(Enter, Space). 전송 버튼의 키보드 실행 판단에 쓴다.
  function isActivationKey(e) {
    return isEnterKey(e) || (!!e && (e.key === ' ' || e.key === 'Spacebar' || e.code === 'Space'));
  }

  function hasModifier(e) {
    return !!e && !!(e.shiftKey || e.ctrlKey || e.altKey || e.metaKey);
  }

  function isComposingEvent(e) {
    return !!e && (e.isComposing === true || e.keyCode === 229);
  }

  // 입력창 내용과 번역문 비교용. 공백·줄바꿈 차이(연속 공백, \r\n, 빈 줄, nbsp)와 폭 없는 공백(U+200B, BOM)은
  // 무시하고 글자 내용은 그대로 비교한다. 이모지 결합 문자(ZWJ)는 지우지 않는다.
  // composer.js의 입력 반영 확인도 이 함수 하나를 쓴다.
  function normalizeForCompare(s) {
    if (s === null || s === undefined) return '';
    let t = String(s);
    if (typeof t.normalize === 'function') t = t.normalize('NFC');
    return t.replace(/[​﻿]/g, '').replace(/\s+/g, ' ').trim();
  }

  root.hasHangul = hasHangul;
  root.decideSend = decideSend;
  root.isEnterKey = isEnterKey;
  root.hasModifier = hasModifier;
  root.isActivationKey = isActivationKey;
  root.isComposingEvent = isComposingEvent;
  root.normalizeForCompare = normalizeForCompare;
})(typeof module !== 'undefined' && module.exports ? module.exports : (self.MBX = self.MBX || {}));
