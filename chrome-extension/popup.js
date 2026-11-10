const FOLDER = { primary: 'Primary', general: 'General', requests: '요청', unknown: '알 수 없음' };

function el(tag, attrs = {}, text) {
  const e = document.createElement(tag);
  Object.assign(e, attrs);
  if (text !== undefined) e.textContent = text;
  return e;
}

chrome.storage.local.get(null).then((all) => {
  const entries = Object.entries(all).filter(([k]) => k.startsWith('last:'));
  if (!entries.length) return;
  const list = document.getElementById('list');
  list.textContent = '';
  for (const [, v] of entries.sort()) {
    const card = el('div', { className: 'card' });
    const head = el('div', { className: 'row' });
    head.append(el('b', {}, `${v.data.account} · ${FOLDER[v.data.folder] || v.data.folder}`));
    head.append(el('span', { className: 'muted' }, new Date(v.at).toLocaleTimeString()));
    card.append(head);
    card.append(el('div', {}, `안 읽은 대화 (제목 기준): ${v.data.unread_total}`));
    const res = v.result || {};
    card.append(el('div', { className: res.ok ? 'ok' : 'bad' }, res.ok ? `수집기 전송 성공 (새 알림 ${res.new})` : `전송 실패: ${res.error}`));
    const unread = (v.data.threads || []).filter((t) => t.unread);
    const ul = el('ul');
    for (const t of unread.slice(0, 10)) ul.append(el('li', {}, `${t.name}: ${t.preview || ''}`));
    if (!unread.length) ul.append(el('li', { className: 'muted' }, '목록에서 안 읽은 대화 없음'));
    card.append(ul);
    list.append(card);
  }
});
