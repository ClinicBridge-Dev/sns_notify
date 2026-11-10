// Runs on instagram.com. Reads ONLY the DM thread list (never opens a thread, never clicks).
(() => {
  const LIST_LABELS = ['대화 리스트', 'Conversation list', 'Thread list', 'Chats', 'チャットリスト'];
  let lastSent = '';
  let lastSentAt = 0;
  let timer = null;

  function listRoot() {
    for (const l of LIST_LABELS) {
      const el = document.querySelector(`[aria-label="${l}"]`);
      if (el) return el;
    }
    return null;
  }

  function accountName(root) {
    const h = root.querySelector('h1, h2');
    const t = (h && h.textContent || '').trim();
    return t && !/^(메시지|messages)$/i.test(t) ? t : null;
  }

  function selectedTab() {
    const tab = document.querySelector('[role="tab"][aria-selected="true"]');
    return tab ? tab.textContent : null;
  }

  function rows(root) {
    const cands = Array.from(root.querySelectorAll('[role="button"], a[href^="/direct/t/"]'))
      .filter((el) => el.querySelector('img'))
      .filter((el) => !el.closest('[role="tablist"]'));
    // keep outermost only
    const outer = cands.filter((el) => !cands.some((o) => o !== el && o.contains(el)));
    return outer
      .map((el) => {
        const lines = (el.innerText || '').split('\n');
        const r = CBParse.parseRowLines(lines);
        if (!r.unread && /\bUnread\b|읽지 않음/.test(el.textContent || '')) r.unread = true;
        return r;
      })
      .filter((r) => CBParse.isMessageRow(r));
  }

  function snapshot() {
    if (!location.pathname.startsWith('/direct')) return null;
    const root = listRoot();
    if (!root) return null;
    const account = accountName(root);
    if (!account) return null;
    return {
      account,
      folder: CBParse.folderFrom(selectedTab(), location.pathname),
      unread_total: CBParse.unreadFromTitle(document.title),
      threads: rows(root).slice(0, 100),
    };
  }

  function tick() {
    let snap;
    try {
      snap = snapshot();
    } catch (e) {
      return;
    }
    if (!snap) return;
    const key = JSON.stringify(snap);
    const now = Date.now();
    if (key === lastSent && now - lastSentAt < 60000) return; // unchanged: heartbeat once a minute
    lastSent = key;
    lastSentAt = now;
    chrome.runtime.sendMessage({ type: 'ig_snapshot', data: snap, url: location.pathname }).catch(() => {});
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(tick, 1500);
  }

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  setInterval(tick, 15000);
  schedule();
})();
