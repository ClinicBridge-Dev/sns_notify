(function (root) {
  // 상수는 constants.js 와 같은 값이다. 순수 로직 파일이 단독으로 로드돼도 동작하도록 여기서 한 번 더 읽는다.
  const C = (typeof module !== 'undefined' && module.exports) ? require('./constants.js') : root;
  const DEDUP_MS = C.DEDUP_MS || 600000;
  const SENT_KEY_TTL_MS = C.SENT_KEY_TTL_MS || 86400000;
  const RETRY_DELAYS_MS = C.RETRY_DELAYS_MS || [30000, 120000, 600000];
  const RETRY_AFTER_CAP_MS = 3600000;

  const CHANNEL_LABELS = { wec: 'WhatsApp', instagram_direct: 'Instagram' };
  // "수신함 열기" 링크. 수신함이 열려 있는 PC의 원격 데스크톱 세션으로 연결한다(채널과 관계없이 같은 주소).
  const INBOX_URL = 'https://remotedesktop.google.com/access/session/f7455f7a-11ba-3cde-5db9-e240570664dd';
  const UNSUPPORTED_PREFIX = "*Message can't be displayed*";
  const UNSUPPORTED_LINE = '수신함에서 표시되지 않는 유형입니다. WhatsApp Business 앱에서 확인하세요';

  function channelLabel(ch) { return CHANNEL_LABELS[ch] || String(ch || ''); }

  // 숫자·공백·+-().만으로 된 이름(숫자 7개 이상)을 전화번호로 보고, 뒤 4자리만 남긴다.
  function maskPhone(name) {
    if (typeof name !== 'string' || !/^[+\d\s\-().]+$/.test(name)) return name;
    const total = (name.match(/\d/g) || []).length;
    if (total < 7) return name;
    let seen = 0;
    return name.replace(/\d/g, function (d) {
      seen++;
      return seen > total - 4 ? d : '*';
    });
  }

  function escapeSlackText(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function cut(s, max) {
    const chars = Array.from(String(s));
    return chars.length > max ? chars.slice(0, max).join('') + '...' : chars.join('');
  }

  function hhmm(ms) {
    const d = new Date(ms);
    const p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function hasDetail(item) { return !!(item.sender || item.preview); }

  // 채널의 현재 배지 숫자(읽지 않은 대화 수, UI 수정 기획서 12-1). 아직 받지 못했으면 '-'.
  function unreadText(counts, ch) {
    const v = counts && counts[ch];
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? String(v) : '-';
  }

  // 고객이 쓴 문자열이 들어가는 줄은 text(이스케이프)와 blocks(plain_text) 두 벌로 만든다.
  // 줄: { label, value, customer }. customer 가 아닌 줄(우리가 만든 문구)은 이스케이프만 거친다.
  // counts: { instagram_direct, wec } 내보내는 시점의 배지 숫자(12-4). 없으면 '-'로 적는다.
  function buildSlackPayload(item, settings, now, counts) {
    settings = settings || {};
    if (item.type === 'system') {
      const t = String(item.text || '');
      return { text: escapeSlackText(t), blocks: [{ type: 'section', text: { type: 'plain_text', text: t } }] };
    }
    const label = channelLabel(item.channel);
    const acct = settings.accountName ? '[' + settings.accountName + ']' : '';
    const detailed = hasDetail(item);
    const count = Number(item.count) > 0 ? Number(item.count) : 1;

    // 숫자는 모두 "대화" 단위다(12-1). 첫 줄의 미확인 대화 수는 그 채널의 현재 배지 숫자이고 항상 적는다(12-3).
    // 한 번에 배지가 2 이상 늘었으면 새로 온 대화 수도 적는다.
    let title;
    if (item.type === 'supplement') title = '방금 [' + label + '] 알림의 상세';
    else {
      title = (item.kind === 'away' ? '자리 비운 사이 새 메시지' : '새 메시지') + (count >= 2 ? ' (대화 ' + count + '개)' : '');
      const unread = unreadText(counts, item.channel);
      title += ' · 미확인 대화 ' + unread + (unread === '-' ? '' : '개');
    }
    // 보충 알림은 "[채널]" 제목을 쓰지 않고 문구 자체에 채널이 들어 있다.
    const head = item.type === 'supplement' ? (acct ? acct + ' ' : '') + title : acct + '[' + label + '] ' + title;

    const lines = [];
    if (detailed) {
      if (item.sender) {
        const name = settings.slackMaskPhone ? maskPhone(item.sender) : item.sender;
        lines.push({ k: '보낸 사람: ', v: cut(name, 100) });
      }
      if (item.preview) {
        const unsupported = String(item.preview).indexOf(UNSUPPORTED_PREFIX) === 0;
        const max = Number(settings.slackPreviewMaxLen) > 0 ? Number(settings.slackPreviewMaxLen) : 100;
        lines.push(unsupported ? { k: '내용: ', v: UNSUPPORTED_LINE, ours: true } : { k: '내용: ', v: cut(item.preview, max) });
      }
    } else {
      lines.push({ k: '', v: '수신함의 ' + label + ' 탭에서 확인하세요', ours: true });
      if (item.manualHint) lines.push({ k: '', v: '수동으로 읽지 않음 표시한 것일 수 있음', ours: true });
    }
    // 두 채널의 현재 배지 숫자를 항상 함께 적는다(12-3). 한 채널 알림만 봐도 전체 상황을 알 수 있게 한다.
    if (item.type !== 'supplement') {
      lines.push({ k: '미확인 현황: ', v: 'Instagram ' + unreadText(counts, 'instagram_direct') + ' · WhatsApp ' + unreadText(counts, 'wec'), ours: true });
    }
    lines.push({ k: '감지: ', v: hhmm(item.createdAt > 0 ? item.createdAt : now), ours: true });

    const url = INBOX_URL;
    const text = [escapeSlackText(head)]
      .concat(lines.map(function (l) { return escapeSlackText(l.k) + escapeSlackText(l.v); }))
      .concat(['수신함 열기: ' + url]).join('\n');
    // 고객 문자열이 섞인 section 은 plain_text 다(멘션·링크로 해석되지 않는다). mrkdwn 은 우리가 만든 링크만 쓴다.
    const blocks = [
      { type: 'section', text: { type: 'plain_text', text: head + '\n' + lines.map(function (l) { return l.k + l.v; }).join('\n') } },
      { type: 'section', text: { type: 'mrkdwn', text: '<' + url + '|수신함 열기>' } }
    ];
    return { text: text, blocks: blocks };
  }

  // 32비트 FNV-1a. 본문 자체를 저장하지 않기 위한 해시이며 보안 용도가 아니다.
  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36);
  }

  function dedupKey(item, now) {
    if (item.type === 'system') return 'system:' + item.id; // 중복 검사 대상이 아니다
    if (hasDetail(item)) return 'd:' + hash([item.channel, item.sender || '', item.preview || '', item.time || ''].join('\u0001'));
    // 배지 전용 알림: 채널 + 배지 값 + 분 단위 시각(기획서 6-4, Ruling 11). 증가분(count)으로 키를 만들면 같은 분 안의
    // +1 두 번(배지 3, 4)이 같은 키가 되어 두 번째 실제 알림이 버려진다. 배지 값이 없는 항목은 항목 id 로 키를 만든다
    // (누락보다 중복이 낫다).
    if (typeof item.badgeValue !== 'number' || !Number.isFinite(item.badgeValue)) return 'b:id:' + String(item.id);
    return 'b:' + hash([item.channel, item.badgeValue, Math.floor(now / 60000)].join('\u0001'));
  }

  function isDuplicate(sentKeys, key, now) {
    return (sentKeys || []).some(function (e) { return e.key === key && now - e.at <= DEDUP_MS; });
  }

  function pruneSentKeys(sentKeys, now) {
    return (sentKeys || []).filter(function (e) { return now - e.at <= SENT_KEY_TTL_MS; });
  }

  // 2xx 는 성공, 0(네트워크 오류)·429·5xx 는 재시도, 그 밖의 4xx 는 설정 오류.
  // 판단이 애매한 코드(3xx 등)는 재시도로 둔다(누락보다 중복이 낫다).
  function classifyStatus(status) {
    if (status >= 200 && status < 300) return 'ok';
    if (status === 429) return 'retry';
    if (status >= 400 && status < 500) return 'config';
    return 'retry';
  }

  // attempts 는 지금까지 실패한 횟수(이번 실패를 반영하기 전 값)다. 0 -> 30초, 1 -> 2분, 2 이상 -> 10분.
  function nextRetryDelayMs(attempts, retryAfterSec) {
    if (typeof retryAfterSec === 'number' && Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
      return Math.min(retryAfterSec * 1000, RETRY_AFTER_CAP_MS);
    }
    const i = Math.max(0, Math.floor(attempts) || 0);
    return RETRY_DELAYS_MS[Math.min(i, RETRY_DELAYS_MS.length - 1)];
  }

  // Slack 설정 상태(Ruling 13). 'disabled': slackEnabled 꺼짐 — 조용히 건너뛴다(오류 아님, 기획서 6-1 여러 설치 안내).
  // 'missing': 켜져 있는데 Webhook 주소가 비어 있음 — 설정 필요 상태(기획서 6-3). 'ok': 보낼 수 있음.
  function slackConfigState(full) {
    if (!full || full.slackEnabled === false) return 'disabled';
    const url = typeof full.slackWebhookUrl === 'string' ? full.slackWebhookUrl.trim() : '';
    return url ? 'ok' : 'missing';
  }

  function isNotConfiguredError(e) {
    return !!e && e.source === 'slack' && e.code === 'NOT_CONFIGURED';
  }

  // 설정 필요 상태를 기록해야 하는지. 이미 같은 상태면 다시 쓰지 않는다(이벤트마다 lastError 를 다시 쓰지 않게).
  function needsNotConfiguredWrite(lastError) {
    return !isNotConfiguredError(lastError);
  }

  // 저장된 설정 필요 상태가 지금 설정에서 더는 맞지 않는지(꺼졌거나 주소가 생김). 다른 오류는 건드리지 않는다.
  function staleNotConfigured(lastError, full) {
    return isNotConfiguredError(lastError) && slackConfigState(full) !== 'missing';
  }

  root.slackConfigState = slackConfigState;
  root.needsNotConfiguredWrite = needsNotConfiguredWrite;
  root.staleNotConfigured = staleNotConfigured;
  root.maskPhone = maskPhone;
  root.escapeSlackText = escapeSlackText;
  root.buildSlackPayload = buildSlackPayload;
  root.dedupKey = dedupKey;
  root.isDuplicate = isDuplicate;
  root.pruneSentKeys = pruneSentKeys;
  root.classifyStatus = classifyStatus;
  root.nextRetryDelayMs = nextRetryDelayMs;
})(typeof module !== 'undefined' && module.exports ? module.exports : (self.MBX = self.MBX || {}));
