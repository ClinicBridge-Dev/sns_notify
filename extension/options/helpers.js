// 설정 화면의 순수 함수(UI 수정 기획서 6장). DOM 과 chrome API 를 쓰지 않는다. test/options-helpers.test.js 가 확인한다.
(function (root) {
  const SECTIONS = ['start', 'slack', 'translate', 'quick', 'help'];
  const SECTION_NAMES = { start: '시작하기', slack: 'Slack 알림', translate: '번역', quick: '빠른 메시지', help: '도움말' };

  // '#slack' → 'slack'. 없거나 모르는 값이면 'start'(6-2).
  function sectionFromHash(hash) {
    const s = String(hash || '').replace(/^#/, '');
    return SECTIONS.indexOf(s) >= 0 ? s : 'start';
  }

  function isSection(s) { return SECTIONS.indexOf(s) >= 0; }

  // 미리보기 길이 선택지. 저장된 값이 목록에 없으면(1~1000 사이의 다른 값) 그 값도 넣어 열기만 해서 바뀌지 않게 한다.
  const PREVIEW_LENS = [40, 80, 100, 140, 200, 300, 500, 1000];
  function previewLenChoices(current) {
    const list = PREVIEW_LENS.slice();
    const n = Number(current);
    if (Number.isInteger(n) && n >= 1 && n <= 1000 && list.indexOf(n) < 0) list.push(n);
    return list.sort(function (a, b) { return a - b; });
  }

  function parseTags(s) {
    return String(s || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
  }

  // 제목·본문·태그에서 대소문자 구분 없이 찾는다. 원래 순서와 위치(index)를 함께 돌려준다.
  function filterQuickReplies(items, query) {
    const q = String(query || '').trim().toLowerCase();
    return (items || []).map(function (it, index) { return { item: it, index: index }; }).filter(function (x) {
      if (!q) return true;
      const it = x.item;
      return [it.title, it.text].concat(it.tags || []).some(function (v) { return String(v || '').toLowerCase().indexOf(q) >= 0; });
    });
  }

  // id 로 찾은 항목을 toId 항목의 자리로 옮긴다(끌어서 놓기). 원본 배열은 바꾸지 않는다. 못 찾으면 null.
  function moveById(items, fromId, toId) {
    const from = items.findIndex(function (x) { return x.id === fromId; });
    const to = items.findIndex(function (x) { return x.id === toId; });
    if (from < 0 || to < 0 || from === to) return null;
    const next = items.slice();
    const moved = next.splice(from, 1)[0];
    next.splice(to, 0, moved);
    return next;
  }

  // id 항목을 한 칸 위(-1)·아래(+1)로. 끝이면 null.
  function stepById(items, id, delta) {
    const i = items.findIndex(function (x) { return x.id === id; });
    const j = i + delta;
    if (i < 0 || j < 0 || j >= items.length) return null;
    const next = items.slice();
    const tmp = next[i]; next[i] = next[j]; next[j] = tmp;
    return next;
  }

  // 편집 영역의 값이 저장된 항목과 다른지. saved 가 없으면(새 메시지) 무엇이든 입력했으면 바뀐 것이다.
  function isDirty(draft, saved) {
    if (!draft) return false;
    const tags = parseTags(draft.tags).join(',');
    if (!saved) return draft.title !== '' || draft.text !== '' || tags !== '';
    return draft.title !== saved.title || draft.text !== saved.text || tags !== (saved.tags || []).join(',');
  }

  // 비밀값 표시. 값 자체는 다시 보여 주지 않는다(6-5).
  function maskedWebhook(url) { return url ? 'https://hooks.slack.com/' + '•'.repeat(12) : ''; }
  function maskedKey(key) { return key ? '•'.repeat(16) + (/:fx$/.test(key) ? ' (:fx)' : '') : ''; }

  function hostOf(origin) { return String(origin).replace(/^https:\/\//, '').replace(/\/\*$/, ''); }

  function missingOrigins(permissions, origins) {
    return (origins || []).filter(function (o) { return !(permissions && permissions[o] === true); });
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // 오늘이면 '14:32:05', 아니면 '11월 12일 14:32'.
  function fmtTime(at, now) {
    if (!at) return '';
    const d = new Date(at);
    const n = new Date(now);
    const hms = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return '오늘 ' + hms;
    return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function fmtAgo(at, now) {
    const s = Math.max(0, Math.round((now - at) / 1000));
    if (s < 60) return s + '초 전';
    const m = Math.floor(s / 60);
    if (m < 60) return m + '분 전';
    const h = Math.floor(m / 60);
    if (h < 24) return h + '시간 전';
    return Math.floor(h / 24) + '일 전';
  }

  // 마지막 Slack 전송 결과 → { tone, text }
  function lastSendText(s, now) {
    if (!s) return { tone: 'gray', text: '아직 보낸 적 없음' };
    const when = fmtTime(s.at, now);
    if (s.outcome === 'ok') return { tone: 'green', text: '성공 · ' + when };
    const why = s.status ? 'HTTP ' + s.status : '네트워크 오류';
    if (s.outcome === 'retry') return { tone: 'red', text: '실패, 재시도 예정 · ' + when + ' (' + why + ')' };
    return { tone: 'red', text: '설정 오류 · ' + when + ' (' + why + ')' };
  }

  const FAIL_REASONS = { login: '로그인/보안 확인 화면', selector: '수신함 화면 요소를 찾지 못함', no_asset_id: '계정 정보를 읽지 못함' };
  function failReasonText(r) { return FAIL_REASONS[r] || (r ? String(r) : ''); }

  // DeepL 사용량 → { pct, text }. limit 이 없으면 null.
  function usageInfo(used, limit) {
    const u = Number(used) || 0;
    const l = Number(limit) || 0;
    if (l <= 0) return null;
    const pct = Math.min(100, Math.round(u / l * 100));
    return { pct: pct, text: u.toLocaleString('ko-KR') + ' / ' + l.toLocaleString('ko-KR') + '자 · ' + pct + '%' };
  }

  // Slack 알림 예시용 고정 메시지(실제 고객 데이터가 아니다). 전화번호 모양의 이름이라 가리기 설정이 보인다.
  const SAMPLE_ITEM = {
    type: 'new', kind: 'new', channel: 'instagram_direct', count: 1,
    sender: '+82 10-1234-5678',
    preview: '안녕하세요. 다음 주 토요일 오후에 상담 예약을 하고 싶습니다. 가능한 시간이 있으면 알려 주세요. 처음 방문이라 준비할 것이 있는지, 건물에 주차가 되는지도 궁금합니다. 답장 기다리겠습니다. 감사합니다.'
  };
  function sampleSlackItem(now) { return Object.assign({}, SAMPLE_ITEM, { createdAt: now }); }

  // buildSlackPayload 의 첫 블록(plain_text) 글을 제목 한 줄과 나머지 줄로 나눈다.
  function splitSlackPreview(payload) {
    const b = payload && payload.blocks && payload.blocks[0] && payload.blocks[0].text;
    const lines = String((b && b.text) || '').split('\n');
    return { head: lines[0] || '', lines: lines.slice(1) };
  }

  const api = {
    SECTIONS: SECTIONS, SECTION_NAMES: SECTION_NAMES, sectionFromHash: sectionFromHash, isSection: isSection,
    previewLenChoices: previewLenChoices, parseTags: parseTags, filterQuickReplies: filterQuickReplies,
    moveById: moveById, stepById: stepById, isDirty: isDirty, maskedWebhook: maskedWebhook, maskedKey: maskedKey,
    hostOf: hostOf, missingOrigins: missingOrigins, fmtTime: fmtTime, fmtAgo: fmtAgo, lastSendText: lastSendText,
    failReasonText: failReasonText, usageInfo: usageInfo, sampleSlackItem: sampleSlackItem, splitSlackPreview: splitSlackPreview
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MBX_OPT = api;
})(typeof self !== 'undefined' ? self : this);
