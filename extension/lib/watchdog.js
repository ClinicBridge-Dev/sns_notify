(function (root) {
  const CONSTS = (typeof module !== 'undefined' && module.exports) ? require('./constants.js') : root;

  // 기획서 6-5 감지 중단 경고. 순수 함수. ws는 watcherState이고 입력을 바꾸지 않고 새 객체를 돌려준다.

  // 담당 탭의 정상 생존 신호(ok: true)를 받았을 때. 중단 경고를 보낸 뒤라면 'resumed'를 1회 돌려준다.
  function onHeartbeat(ws, now) {
    const alert = ws && ws.stoppedAlertSent ? 'resumed' : null;
    return { ws: Object.assign({}, ws, { lastHeartbeat: now, everSeen: true, stoppedAlertSent: false }), alert: alert };
  }

  // 1분 알람마다. 직전 알람과 SLEEP_GAP_MS 이상 벌어졌으면(절전 복귀) 이번 회차는 판단하지 않는다.
  // 대상 계정이 없거나 생존 신호를 한 번도 받지 않았으면 감시하지 않는다. STOP_AFTER_MS를 넘게(초과) 신호가 없으면 'stopped'를 1회.
  function watchdogTick(ws, assetId, now) {
    const prev = ws && typeof ws.lastAlarmAt === 'number' ? ws.lastAlarmAt : 0;
    const next = Object.assign({}, ws, { lastAlarmAt: now });
    if (now - prev >= CONSTS.SLEEP_GAP_MS) return { ws: next, alert: null };
    if (typeof assetId !== 'string' || !assetId.trim() || !next.everSeen) return { ws: next, alert: null };
    if (next.stoppedAlertSent) return { ws: next, alert: null };
    if (now - (next.lastHeartbeat || 0) > CONSTS.STOP_AFTER_MS) {
      next.stoppedAlertSent = true;
      return { ws: next, alert: 'stopped' };
    }
    return { ws: next, alert: null };
  }

  root.onHeartbeat = onHeartbeat;
  root.watchdogTick = watchdogTick;
})(typeof module !== 'undefined' && module.exports ? module.exports : (self.MBX = self.MBX || {}));
