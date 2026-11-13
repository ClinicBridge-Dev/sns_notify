// 설정 화면의 상단 상태 줄(UI 수정 기획서 6-3)과 시작하기 점검표(6-4)의 판정. 순수 함수.
// 입력 st 는 GET_STATUS 응답이다. 표는 위에서부터 차례로 따져 처음 맞는 줄을 쓴다.
// 돌려주는 값: { tone: 'gray'|'red'|'yellow'|'green', label, section } — section 은 누르면 이동할 메뉴.
(function (root) {
  const ORIGIN = {
    meta: 'https://business.facebook.com/*',
    slack: 'https://hooks.slack.com/*',
    deepl: 'https://api.deepl.com/*',
    deeplFree: 'https://api-free.deepl.com/*'
  };
  const HOST_ORIGINS = [ORIGIN.meta, ORIGIN.slack, ORIGIN.deepl, ORIGIN.deeplFree];
  const HEALTHY_MS = 90000;  // OWNER_TIMEOUT_MS 와 같다
  const STOPPED_MS = 180000; // STOP_AFTER_MS 와 같다(Slack 중단 경고 조건)

  function r(tone, label, section) { return { tone: tone, label: label, section: section }; }
  function allowed(st, origin) { return !!(st && st.permissions && st.permissions[origin] === true); }

  function detectStatus(st, now) {
    const d = (st && st.detect) || {};
    const last = typeof st.lastHeartbeat === 'number' ? st.lastHeartbeat : 0;
    if (!st.assetId) return r('gray', '설정 필요', 'slack');
    if (d.failing) return r('red', '확인 필요', 'slack');
    if (d.everSeen && now - last > STOPPED_MS) return r('red', '중단됨', 'slack');
    if (last && now - last <= HEALTHY_MS) return r('green', '정상', 'slack');
    return r('yellow', '수신함 탭 확인', 'slack');
  }

  function slackStatus(st) {
    if (!st.slackEnabled) return r('gray', '사용 안 함', 'slack');
    if (!st.webhookSet) return r('gray', '설정 필요', 'slack');
    if (!allowed(st, ORIGIN.slack)) return r('red', '권한 필요', 'start');
    if (st.lastSend && st.lastSend.outcome !== 'ok') return r('red', '확인 필요', 'slack');
    if (st.retryCount > 0) return r('yellow', '재시도 중', 'slack');
    if (!st.lastSend) return r('yellow', '테스트 필요', 'slack');
    return r('green', '정상', 'slack');
  }

  function translateStatus(st) {
    const d = st.deepl || {};
    if (!d.hasKey) return r('gray', '설정 필요', 'translate');
    if (!allowed(st, d.free ? ORIGIN.deeplFree : ORIGIN.deepl)) return r('red', '권한 필요', 'start');
    if (!d.ok && (d.code === 'BAD_KEY' || d.code === 'QUOTA')) return r('red', '확인 필요', 'translate');
    if (!d.checkedAt) return r('yellow', '키 확인 필요', 'translate');
    if (d.limit > 0 && d.used / d.limit >= 0.9) return r('yellow', '사용량 주의', 'translate');
    if (d.free) return r('yellow', '무료 키', 'translate');
    if (d.ok) return r('green', '정상', 'translate');
    return r('yellow', '키 확인 필요', 'translate'); // 마지막 확인이 키 오류가 아닌 이유로 실패한 경우
  }

  // 6-4 점검표. state: 'done' | 'todo' | 'skip'(Slack 알림 사용 안 함, 완료로 센다)
  function startSteps(st) {
    const slackOff = !st.slackEnabled;
    const d = st.deepl || {};
    const step = function (id, ok, skippable) {
      return { id: id, state: skippable && slackOff ? 'skip' : ok ? 'done' : 'todo' };
    };
    return [
      step('permissions', HOST_ORIGINS.every(function (o) { return allowed(st, o); }), false),
      step('webhook', !!st.webhookSet, true),
      step('account', !!st.assetId, true),
      step('deepl', !!d.hasKey, false),
      step('slackTest', st.slackTestOkAt > 0, true)
    ];
  }

  // 사이트 액세스 권한이 꺼져 요청이 실패했을 때의 오류(7-1).
  const PERMISSION_OFF = { code: 'PERMISSION_OFF', message: '확장 프로그램의 사이트 액세스 권한이 꺼져 있습니다' };

  // 요청 주소 → host_permissions 패턴. 네 곳이 아니면 null.
  function originPatternFor(url) {
    const m = /^https:\/\/([^/]+)\//.exec(typeof url === 'string' ? url : '');
    const p = m ? 'https://' + m[1] + '/*' : null;
    return p && HOST_ORIGINS.indexOf(p) >= 0 ? p : null;
  }

  root.PERMISSION_OFF = PERMISSION_OFF;
  root.originPatternFor = originPatternFor;
  root.HOST_ORIGINS = HOST_ORIGINS;
  root.detectStatus = detectStatus;
  root.slackStatus = slackStatus;
  root.translateStatus = translateStatus;
  root.startSteps = startSteps;
})(typeof module !== 'undefined' && module.exports ? module.exports : (self.MBX = self.MBX || {}));
