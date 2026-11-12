// 기획서 6-1 신호 2: 대화 목록 항목 파싱, 키, 후보 판정, 안정화 상태, 가려진 탭의 연속 두 번 관찰.
// 순수 함수만 둔다(DOM, chrome API 없음). 본문을 로그에 남기지 않는다.
(function (root) {
  const CONSTS = (typeof module !== 'undefined' && module.exports) ? require('./constants.js') : root;
  const CHANNELS = ['instagram_direct', 'wec'];
  const FIELD_MAX = 1000; // LIST_CANDIDATE 필드 길이 상한(형식 검사용)

  // 기획서 3-3: 1) 이름, 2) 미리보기, 3) 날짜 단어, 4) 시각, 5) 라벨(있을 때)
  function parseItemLines(lines) {
    if (!Array.isArray(lines)) return null;
    const ls = lines
      .map(function (l) { return typeof l === 'string' ? l.trim() : ''; })
      .filter(function (l) { return l !== ''; });
    if (ls.length < 4) return null;
    return { name: ls[0], preview: ls[1], time: ls[3] };
  }

  // 오늘 수신이면 "1:59 PM" 같은 시:분 형태다(이전이면 "Wed"). 24시간 표기와 오전/오후 접두도 받는다.
  function isTodayTime(time) {
    if (typeof time !== 'string') return false;
    return /^(?:오전|오후)?\s*\d{1,2}:\d{2}(?:\s*[AaPp]\.?\s?[Mm]\.?)?$/.test(time.trim());
  }

  function isOwnMessage(preview) {
    return typeof preview === 'string' && preview.indexOf('You: ') === 0;
  }

  // "Typing…", "typing...", "입력 중…" 같은 입력 중 표시. 문장 중간의 typing 은 제외한다.
  function isTyping(preview) {
    if (typeof preview !== 'string') return false;
    const p = preview.trim();
    return /^(?:.+\sis\s+)?typing\s*(?:…|\.\.\.)?$/i.test(p) || /^입력\s?중\s*(?:…|\.\.\.)?$/.test(p);
  }

  // FNV-1a 32비트, 8자리 16진 문자열. UTF-16 코드 단위 기준.
  function fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return ('0000000' + (h >>> 0).toString(16)).slice(-8);
  }

  function itemKey(item) {
    const f = function (v) { return typeof v === 'string' ? v : ''; };
    return fnv1a([f(item.channel), f(item.name), f(item.preview), f(item.time)].join('\u001f'));
  }

  // items: 위에서부터 {channel, name, preview, time, key}. known: Set<string>.
  function findCandidates(items, known) {
    const top = (Array.isArray(items) ? items : []).slice(0, CONSTS.LIST_TOP_N);
    let first = -1;
    for (let i = 0; i < top.length; i++) if (known.has(top[i].key)) { first = i; break; }
    if (first < 0) return { candidates: [], reset: true };
    const candidates = top.slice(0, first).filter(function (it) {
      return !known.has(it.key) && !isOwnMessage(it.preview) && !isTyping(it.preview) && isTodayTime(it.time);
    });
    if (candidates.length > CONSTS.CANDIDATE_MAX) return { candidates: [], reset: true };
    return { candidates: candidates, reset: false };
  }

  // Set의 삽입 순서를 쓴다. 다시 본 키는 맨 뒤로 옮기고, cap 초과 시 오래된 것부터 지운다.
  function remember(known, keys, cap) {
    (keys || []).forEach(function (k) {
      if (known.has(k)) known.delete(k);
      known.add(k);
    });
    while (known.size > cap) known.delete(known.values().next().value);
  }

  // ---- 안정화 상태: { phase: 'load' | 'change' | 'ready', lastChange } ----
  function settleStart(now) { return { phase: 'load', lastChange: now }; }

  // 'load' 중에 'change' 진입이 오면 더 긴 'load'를 유지하고 시간만 다시 센다.
  function settleEnter(st, kind, now) {
    const phase = (st && st.phase === 'load' && kind === 'change') ? 'load' : kind;
    return { phase: phase, lastChange: now };
  }

  // 배지·목록 변화. 'ready' 상태에서는 아무 영향이 없다.
  function settleTouch(st, now) {
    return st.phase === 'ready' ? st : { phase: st.phase, lastChange: now };
  }

  function settleTick(st, now) {
    if (st.phase === 'ready') return { state: st, becameReady: false, from: null };
    const wait = st.phase === 'load' ? CONSTS.SETTLE_LOAD_MS : CONSTS.SETTLE_CHANGE_MS;
    if (now - st.lastChange < wait) return { state: st, becameReady: false, from: null };
    return { state: { phase: 'ready', lastChange: st.lastChange }, becameReady: true, from: st.phase };
  }

  // 가려진 탭: 직전 관찰에서도 같은 키로 후보였던 것만 확정한다.
  function confirmTwice(prevKeys, candidates) {
    const prev = prevKeys instanceof Set ? prevKeys : new Set();
    const confirmed = [], unconfirmed = [];
    candidates.forEach(function (c) { (prev.has(c.key) ? confirmed : unconfirmed).push(c); });
    return { confirmed: confirmed, unconfirmed: unconfirmed, next: new Set(candidates.map(function (c) { return c.key; })) };
  }

  // service worker의 LIST_CANDIDATE 형식 검사(asset_id 비교는 호출한 쪽이 한다).
  function validCandidateMsg(msg) {
    if (!msg || typeof msg !== 'object') return false;
    if (CHANNELS.indexOf(msg.channel) < 0) return false;
    const str = function (v, allowEmpty) {
      return typeof v === 'string' && v.length <= FIELD_MAX && (allowEmpty || v.trim() !== '');
    };
    return str(msg.sender, false) && str(msg.preview, true) && str(msg.time, false) && isTodayTime(msg.time);
  }

  root.parseItemLines = parseItemLines;
  root.isTodayTime = isTodayTime;
  root.isOwnMessage = isOwnMessage;
  root.isTyping = isTyping;
  root.fnv1a = fnv1a;
  root.itemKey = itemKey;
  root.findCandidates = findCandidates;
  root.remember = remember;
  root.settleStart = settleStart;
  root.settleEnter = settleEnter;
  root.settleTouch = settleTouch;
  root.settleTick = settleTick;
  root.confirmTwice = confirmTwice;
  root.validCandidateMsg = validCandidateMsg;
})(typeof module !== 'undefined' && module.exports ? module.exports : (self.MBX = self.MBX || {}));
