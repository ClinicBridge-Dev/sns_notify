// Meta 화면 안에 넣는 확장 프로그램 요소의 공용 도우미(UI 수정 기획서 2장). 말풍선 액션 줄과 입력창 위 도구 막대가 함께 쓴다.
(function (root) {
  // 넣은 요소 안에서 생긴 이벤트가 Meta 의 핸들러로 올라가지 않게 한다(2장 10번). 호스트(Shadow DOM 의 바깥 요소)에 건다.
  const SHIELDED_EVENTS = ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu',
    'keydown', 'keypress', 'keyup', 'input'];
  function shieldEvents(hostEl) {
    SHIELDED_EVENTS.forEach(function (t) { hostEl.addEventListener(t, function (e) { e.stopPropagation(); }); });
  }

  // 넣은 요소 때문에 대화 스크롤이 튀지 않게 한다(3-6). mutate 안에서 요소를 넣거나 지운다.
  // - 넣기 직전에 맨 아래(40px 이내)였으면 넣은 뒤에도 맨 아래로 맞춘다.
  // - 아니면 화면에 보이던 첫 말풍선의 위치를 넣기 전후로 재서 달라진 만큼만 scrollTop 을 고친다.
  //   브라우저의 스크롤 앵커링이 이미 위치를 지켰으면 차이가 0이라 두 번 움직이지 않는다(V7).
  // - flex-direction: column-reverse 이면 scrollTop 의 기준이 반대다(맨 아래가 0, V6).
  function keepScroll(region, mutate) {
    if (!region || typeof region.getBoundingClientRect !== 'function') { mutate(); return; }
    let reverse = false;
    try { reverse = getComputedStyle(region).flexDirection === 'column-reverse'; } catch (e) { /* 기본 방향으로 본다 */ }
    const st = region.scrollTop || 0;
    const gap = reverse ? Math.abs(st) : (region.scrollHeight - region.clientHeight - st);
    const atBottom = gap <= 40;
    let anchor = null;
    let before = 0;
    if (!atBottom) {
      // 실제로 화면(대화 영역) 안에 보이는 말풍선을 기준으로 삼는다. column-reverse 이면 문서 순서와 화면 순서가 반대다.
      const rr = region.getBoundingClientRect();
      const items = region.querySelectorAll('[data-message-id]');
      for (let i = 0; i < items.length; i++) {
        const r = items[i].getBoundingClientRect();
        if (r.bottom > rr.top && r.top < rr.bottom) { anchor = items[i]; before = r.top; break; }
      }
    }
    mutate();
    if (atBottom) { region.scrollTop = reverse ? 0 : region.scrollHeight; return; }
    if (anchor && anchor.isConnected) {
      const d = anchor.getBoundingClientRect().top - before;
      if (Math.abs(d) >= 1) region.scrollTop = (region.scrollTop || 0) + d;
    }
  }

  root.inject = { shieldEvents: shieldEvents, keepScroll: keepScroll, SHIELDED_EVENTS: SHIELDED_EVENTS };
})(typeof module !== 'undefined' && module.exports ? module.exports : (self.MBX = self.MBX || {}));
