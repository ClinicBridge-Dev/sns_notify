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
    // 이벤트에는 증가분(count)과 이번 배지 값(value)을 함께 담는다. 건수 알림의 중복 키는 배지 값을 쓴다(기획서 6-4, Ruling 11).
    if (value > base) return { ch: { base: value, known: true, pending: null }, event: { count: value - base, value: value } };
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

  function freshChannels() {
    const out = {};
    CHANNELS.forEach(function (c) { out[c] = { base: 0, known: false, pending: null }; });
    return out;
  }

  // 알림 대상 계정이 바뀌면 이전 계정의 기준값(base/known/pending)을 버린다. 그대로 두면 새 계정의 첫 보고가
  // 이전 계정 값과 비교돼 "자리 비운 사이" 알림이 잘못 나간다. channelsAsset 은 기준값이 속한 계정이다.
  // 기록이 없는(이전 버전) 상태는 지금 계정의 것으로 받아들인다. 바뀐 것이 없으면 같은 객체를 돌려준다.
  function resetChannelsForAsset(ws, assetId) {
    if (typeof assetId !== 'string' || !assetId) return ws;
    const cur = ws && typeof ws.channelsAsset === 'string' ? ws.channelsAsset : null;
    if (cur === assetId) return ws;
    if (cur === null) return Object.assign({}, ws, { channelsAsset: assetId });
    return Object.assign({}, ws, { channels: freshChannels(), channelsAsset: assetId });
  }

  // 순수 함수. state 는 watcherState({ channels, ... }). 잘못된 보고는 그대로 돌려준다.
  // assetId(선택)가 있으면 먼저 resetChannelsForAsset 을 적용한다.
  function handleBadgeState(state, msg, now, assetId) {
    if (!validReport(msg)) return { state: state, events: [] };
    state = resetChannelsForAsset(state, assetId);
    const channels = Object.assign({}, state.channels);
    const events = [];
    const at = (typeof msg.at === 'number' && Number.isFinite(msg.at)) ? msg.at : now;
    CHANNELS.forEach(function (c) {
      const cur = channels[c] || { base: 0, known: false, pending: null };
      const r = applyBadgeReport(cur, msg.badges[c], now, CONSTS.DROP_WAIT_MS);
      channels[c] = r.ch;
      if (r.event) {
        events.push({
          channel: c, count: r.event.count, badgeValue: r.event.value, kind: msg.initial ? 'away' : 'new',
          manualHint: !!msg.userActionRecent, at: at
        });
      }
    });
    return { state: Object.assign({}, state, { channels: channels }), events: events };
  }

  root.applyBadgeReport = applyBadgeReport;
  root.handleBadgeState = handleBadgeState;
  root.resetChannelsForAsset = resetChannelsForAsset;
})(typeof module !== 'undefined' && module.exports ? module.exports : (self.MBX = self.MBX || {}));
