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
    // 원인별 실패 경고가 나가 있으면 같은 원인으로 일반 중단 경고를 또 보내지 않는다(재개 시 failAlerts 가 비워진다).
    if (Array.isArray(next.failAlerts) && next.failAlerts.length) return { ws: next, alert: null };
    if (now - (next.lastHeartbeat || 0) > CONSTS.STOP_AFTER_MS) {
      next.stoppedAlertSent = true;
      return { ws: next, alert: 'stopped' };
    }
    return { ws: next, alert: null };
  }

  // 감지 실패 경고를 받을 경로(기획서 6-5, 최종 검토 8번). 관련 없는 Business 화면(비밀번호 입력란이 있는 설정 화면 등)이
  // "로그인 화면" 경고를 내지 않게 한다.
  // - selector, no_asset_id: 수신함 경로에서만.
  // - login: 수신함 경로, 또는 수신함이었던 탭(wasInboxTab)이 로그인·보안 확인 경로로 바뀐 경우.
  // BLOCKED_PATH_RE 는 content/selectors.js 의 같은 이름 값과 같다(service worker 는 selectors.js 를 읽지 않는다).
  const INBOX_PATH_RE = /^\/latest\/inbox(?:[/?#]|$)/;
  const BLOCKED_PATH_RE = /^\/(?:login(?:[/.?]|$)|checkpoint(?:\/|$)|two_step_verification(?:\/|$)|two_factor(?:\/|$))/;
  const INBOX_TABS_CAP = 50;

  function failureReportAllowed(reason, path, wasInboxTab) {
    if (typeof path !== 'string') return false;
    const inbox = INBOX_PATH_RE.test(path);
    if (reason === 'selector' || reason === 'no_asset_id') return inbox;
    if (reason === 'login') return inbox || (!!wasInboxTab && BLOCKED_PATH_RE.test(path));
    return false;
  }

  // 수신함 경로에서 소식을 보낸 탭 번호 목록(최근 INBOX_TABS_CAP 개). 바뀐 것이 없으면 같은 배열을 돌려준다.
  function rememberInboxTab(ids, tabId, path) {
    const list = Array.isArray(ids) ? ids : [];
    if (typeof tabId !== 'number' || typeof path !== 'string' || !INBOX_PATH_RE.test(path) || list.indexOf(tabId) >= 0) return list;
    return list.concat([tabId]).slice(-INBOX_TABS_CAP);
  }

  function forgetInboxTab(ids, tabId) {
    const list = Array.isArray(ids) ? ids : [];
    return list.indexOf(tabId) < 0 ? list : list.filter(function (t) { return t !== tabId; });
  }

  root.failureReportAllowed = failureReportAllowed;
  root.rememberInboxTab = rememberInboxTab;
  root.forgetInboxTab = forgetInboxTab;
  root.onHeartbeat = onHeartbeat;
  root.watchdogTick = watchdogTick;
})(typeof module !== 'undefined' && module.exports ? module.exports : (self.MBX = self.MBX || {}));
