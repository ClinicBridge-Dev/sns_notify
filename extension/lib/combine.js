(function (root) {
  const C = (typeof module !== 'undefined' && module.exports) ? require('./constants.js') : root;
  const HOLD_MS = C.HOLD_MS || 5000;
  const SUPPLEMENT_WINDOW_MS = C.SUPPLEMENT_WINDOW_MS || 120000;

  // st = { queue, recent }. 모든 함수는 입력을 바꾸지 않고 새 st 를 돌려준다.
  function makeItem(newId, now, o) {
    return Object.assign({
      id: newId(), type: 'badge', channel: '', count: 1, badgeValue: null, kind: 'new', manualHint: false,
      sender: null, preview: null, time: null, text: null,
      createdAt: now, status: 'ready', holdUntil: null, attempts: 0, nextTryAt: 0
    }, o);
  }

  function hasDetail(it) { return !!(it.sender || it.preview); }

  // 이벤트의 절대 배지 값(건수 알림 중복 키용, 기획서 6-4). 없으면 null.
  function bv(ev) { return typeof ev.badgeValue === 'number' && Number.isFinite(ev.badgeValue) ? ev.badgeValue : null; }

  function routeBadgeEvent(st, ev, now, newId) {
    const queue = st.queue.slice();
    const recent = st.recent.slice();
    if (ev.kind === 'away') {
      // 자리 비운 사이 알림은 보류하지 않고 건수 알림으로 바로 보낸다. 보충 기록도 남기지 않는다.
      queue.push(makeItem(newId, now, { type: 'badge', channel: ev.channel, count: ev.count, badgeValue: bv(ev), kind: 'away', manualHint: !!ev.manualHint }));
      return { queue: queue, recent: recent };
    }
    // 같은 채널에서 먼저 도착해 보류 중인 목록 항목(가장 오래된 것)과 합친다.
    const i = queue.findIndex(function (q) { return q.status === 'hold' && q.type === 'list' && q.channel === ev.channel; });
    if (i >= 0) {
      queue[i] = Object.assign({}, queue[i], { count: ev.count, badgeValue: bv(ev), kind: ev.kind, manualHint: !!ev.manualHint, status: 'ready', holdUntil: null });
      return { queue: queue, recent: recent };
    }
    queue.push(makeItem(newId, now, {
      type: 'badge', channel: ev.channel, count: ev.count, badgeValue: bv(ev), kind: ev.kind, manualHint: !!ev.manualHint,
      status: 'hold', holdUntil: now + HOLD_MS
    }));
    return { queue: queue, recent: recent };
  }

  function routeCandidate(st, cand, now, newId) {
    const queue = st.queue.slice();
    let recent = st.recent.slice();
    // ① 상세 정보가 없는 보류 배지 항목과 합친다.
    const i = queue.findIndex(function (q) { return q.status === 'hold' && q.type === 'badge' && q.channel === cand.channel && !hasDetail(q); });
    if (i >= 0) {
      queue[i] = Object.assign({}, queue[i], { sender: cand.sender, preview: cand.preview, time: cand.time, status: 'ready', holdUntil: null });
      return { queue: queue, recent: recent };
    }
    // ② 2분 안의 건수 알림이 남아 있으면 보충 메시지로 보내고 남은 수를 줄인다.
    const j = recent.findIndex(function (r) { return r.channel === cand.channel && r.remaining > 0 && now - r.at <= SUPPLEMENT_WINDOW_MS; });
    if (j >= 0) {
      recent[j] = Object.assign({}, recent[j], { remaining: recent[j].remaining - 1 });
      queue.push(makeItem(newId, now, { type: 'supplement', channel: cand.channel, count: 1, sender: cand.sender, preview: cand.preview, time: cand.time }));
      return { queue: queue, recent: recent };
    }
    // ③ 새 목록 항목을 보류한다.
    queue.push(makeItem(newId, now, {
      type: 'list', channel: cand.channel, count: 1, sender: cand.sender, preview: cand.preview, time: cand.time,
      status: 'hold', holdUntil: now + HOLD_MS
    }));
    return { queue: queue, recent: recent };
  }

  function releaseDue(st, now) {
    const recent = st.recent.filter(function (r) { return now - r.at <= SUPPLEMENT_WINDOW_MS; });
    const queue = st.queue.map(function (q) {
      if (q.status !== 'hold' || !(q.holdUntil <= now)) return q;
      if (q.type === 'badge' && !hasDetail(q)) recent.push({ channel: q.channel, at: now, remaining: q.count });
      return Object.assign({}, q, { status: 'ready', holdUntil: null });
    });
    return { queue: queue, recent: recent };
  }

  root.routeBadgeEvent = routeBadgeEvent;
  root.routeCandidate = routeCandidate;
  root.releaseDue = releaseDue;
})(typeof module !== 'undefined' && module.exports ? module.exports : (self.MBX = self.MBX || {}));
