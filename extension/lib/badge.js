(function (root) {
  const CONSTS = (typeof module !== 'undefined' && module.exports) ? require('./constants.js') : root;
  const CHANNELS = ['instagram_direct', 'wec'];

  // 기획서 6-1 신호 1. 순서(①~⑤)를 바꾸지 않는다. 입력을 바꾸지 않고 새 객체를 돌려준다.
  function applyBadgeReport(ch, value, now, dropWaitMs) {
    // ① 처음 받은 값은 기준값만 저장한다
    if (!ch.known) return { ch: { base: value, known: true, pending: null }, event: null };
    let base = ch.base;
    let pending = ch.pending ? { value: ch.pending.value, at: ch.pending.at } : null;
    // ② 감소 대기가 끝났으면 낮아진 값을 기준값으로 확정한다
    if (pending && now - pending.at > dropWaitMs) { base = pending.value; pending = null; }
    // ③ 기준값보다 크면 이벤트
    if (value > base) return { ch: { base: value, known: true, pending: null }, event: { count: value - base } };
    // ④ 같으면 감소 대기를 지운다
    if (value === base) return { ch: { base: base, known: true, pending: null }, event: null };
    // ⑤ 작으면 감소 대기를 저장한다(이미 있으면 시각은 두고 값만 바꾼다)
    pending = pending ? { value: value, at: pending.at } : { value: value, at: now };
    return { ch: { base: base, known: true, pending: pending }, event: null };
  }

  function validReport(msg) {
    if (!msg || typeof msg !== 'object' || !msg.badges || typeof msg.badges !== 'object') return false;
    return CHANNELS.every(function (c) {
      const v = msg.badges[c];
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
    });
  }

  // 순수 함수. state 는 watcherState({ channels, ... }). 잘못된 보고는 그대로 돌려준다.
  function handleBadgeState(state, msg, now) {
    if (!validReport(msg)) return { state: state, events: [] };
    const channels = Object.assign({}, state.channels);
    const events = [];
    const at = (typeof msg.at === 'number' && Number.isFinite(msg.at)) ? msg.at : now;
    CHANNELS.forEach(function (c) {
      const cur = channels[c] || { base: 0, known: false, pending: null };
      const r = applyBadgeReport(cur, msg.badges[c], now, CONSTS.DROP_WAIT_MS);
      channels[c] = r.ch;
      if (r.event) {
        events.push({
          channel: c, count: r.event.count, kind: msg.initial ? 'away' : 'new',
          manualHint: !!msg.userActionRecent, at: at
        });
      }
    });
    return { state: Object.assign({}, state, { channels: channels }), events: events };
  }

  root.applyBadgeReport = applyBadgeReport;
  root.handleBadgeState = handleBadgeState;
})(typeof module !== 'undefined' && module.exports ? module.exports : (self.MBX = self.MBX || {}));
