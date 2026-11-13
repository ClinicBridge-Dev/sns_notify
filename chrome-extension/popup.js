const FOLDER = { primary: 'Primary', general: 'General', requests: '요청', unknown: '알 수 없음' };

function el(tag, attrs = {}, text) {
  const e = document.createElement(tag);
  Object.assign(e, attrs);
  if (text !== undefined) e.textContent = text;
  return e;
}

function render(all) {
  const entries = Object.entries(all).filter(([k]) => k.startsWith('last:'));
  if (!entries.length) return;
  const list = document.getElementById('list');
  list.textContent = '';
  for (const [, v] of entries.sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at))) {
    const card = el('div', { className: 'card' });
    const head = el('div', { className: 'row' });
    head.append(el('b', {}, `${v.data.account} · ${FOLDER[v.data.folder] || v.data.folder}`));
    head.append(el('span', { className: 'muted' }, new Date(v.at).toLocaleTimeString()));
    card.append(head);
    const unread = (v.data.threads || []).filter((t) => t.unread);
    card.append(el('div', {}, `현재 목록의 안 읽은 대화: ${unread.length}개`));
    const stale = Date.now() - Date.parse(v.at) > 120000;
    const supported = ['primary', 'general', 'requests'].includes(v.data.folder);
    if (stale) card.append(el('div', { className: 'bad' }, '2분 넘게 갱신되지 않은 기록입니다. DM 목록 페이지를 확인해 주세요.'));
    if (!supported) card.append(el('div', { className: 'bad' }, '이 화면에서는 알림을 생성하지 않습니다. DM 목록의 Primary, General 또는 요청을 열어 두세요.'));
    const res = v.result || {};
    if (res.warning === 'instagram_account_unmapped') {
      card.append(el('div', { className: 'bad' }, `@${v.data.account}의 Slack 전송 채널이 설정되지 않았습니다. 서버의 계정 연결 설정이 필요합니다.`));
    }
    card.append(el('div', { className: res.ok ? 'muted' : 'bad' }, res.ok ? `서버 수신 성공 · 이번 수집에서 생성된 알림 ${res.new || 0}건 (Slack 도착 여부와 별개)` : `전송 실패: ${res.error}`));
    const ul = el('ul');
    for (const t of unread.slice(0, 10)) ul.append(el('li', {}, `${t.name}: ${t.preview || ''}`));
    if (!unread.length) ul.append(el('li', { className: 'muted' }, '목록에서 안 읽은 대화 없음'));
    card.append(ul);
    list.append(card);
  }
}

function refresh() { chrome.storage.local.get(null).then(render); }
chrome.storage.onChanged.addListener(refresh);
setInterval(refresh, 15000);
refresh();
