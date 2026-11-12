(function (root) {
  const INBOX_PREFIX = '/latest/inbox';

  function isCandidate(t, assetId) {
    return !!t && typeof t.tabId === 'number' && t.assetId === assetId &&
      typeof t.path === 'string' && t.path.indexOf(INBOX_PREFIX) === 0;
  }

  // 기획서 6-1 "감지 담당 탭". 순수 함수.
  // 후보: assetId가 같고 path가 /latest/inbox로 시작하는 탭. 현재 담당이 후보이고 살아 있으면(now - lastSeen <= timeoutMs) 유지한다.
  // 아니면 lastSeen이 가장 최근인 후보. 단, 시간 초과로 물러나는 담당은 다른 후보가 있으면 고르지 않는다
  // (대기 탭은 생존 신호를 보내지 않아 lastSeen이 오래됐을 수 있으므로, 그대로 비교하면 멈춘 담당이 계속 뽑힌다).
  function chooseOwner(currentOwnerId, tabs, assetId, now, timeoutMs) {
    if (typeof assetId !== 'string' || !assetId) return null;
    const cands = (Array.isArray(tabs) ? tabs : []).filter(function (t) { return isCandidate(t, assetId); });
    if (!cands.length) return null;
    const cur = cands.find(function (t) { return t.tabId === currentOwnerId; });
    if (cur && now - (cur.lastSeen || 0) <= timeoutMs) return cur.tabId;
    const others = cur ? cands.filter(function (t) { return t !== cur; }) : cands;
    const pool = others.length ? others : cands;
    let best = pool[0];
    pool.forEach(function (t) { if ((t.lastSeen || 0) > (best.lastSeen || 0)) best = t; });
    return best.tabId;
  }

  root.chooseOwner = chooseOwner;
})(typeof module !== 'undefined' && module.exports ? module.exports : (self.MBX = self.MBX || {}));
