// Pure parsing helpers (no DOM). Loaded by content.js and by node tests.
(function (root) {
  const UNREAD = /^(Unread|읽지 않음|안 읽음|未読)$/i;
  const SEP = /^[·•|]$/;
  const TIME = /^(방금|지금|now|just now|\d+\s*(초|분|시간|일|주|개월|년|s|m|h|d|w|y|min|mins|hr|hrs|wk|wks))$/i;

  function parseRowLines(lines) {
    const clean = lines.map((s) => String(s).trim()).filter((s) => s && !SEP.test(s));
    const unread = clean.some((l) => UNREAD.test(l));
    const rest = clean.filter((l) => !UNREAD.test(l));
    let time_label = null;
    if (rest.length > 1 && TIME.test(rest[rest.length - 1])) time_label = rest.pop();
    const name = (rest.shift() || '').replace(/님$/, '').trim();
    const preview = rest.join(' ').replace(/\s+/g, ' ').trim() || null;
    return { name, preview, time_label, unread };
  }

  function folderFrom(selectedTabLabel, pathname) {
    const t = (selectedTabLabel || '').trim().toLowerCase();
    if (/^(general|일반)/.test(t)) return 'general';
    if (/^(primary|기본)/.test(t)) return 'primary';
    if (/^(requests?|요청)/.test(t)) return 'requests';
    const p = pathname || '';
    if (p.includes('/requests')) return 'requests';
    if (p.includes('/general')) return 'general';
    if (p.startsWith('/direct/inbox')) return 'primary';
    return 'unknown';
  }

  function unreadFromTitle(title) {
    const m = /^\((\d+)\)/.exec((title || '').trim());
    return m ? Number(m[1]) : 0;
  }

  // Real conversation rows always carry a relative time ("10시간") or an unread marker; the notes
  // bubble ("내 메모") and empty placeholder chats do not.
  function isMessageRow(r) {
    return Boolean(r && r.name && (r.time_label || r.unread));
  }

  const api = { parseRowLines, folderFrom, unreadFromTitle, isMessageRow };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CBParse = api;
})(typeof self !== 'undefined' ? self : this);
