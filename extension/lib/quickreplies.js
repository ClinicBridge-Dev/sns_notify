(function (root) {
  const C = typeof module !== 'undefined' && module.exports ? require('./constants.js') : root;
  const MAX_ITEMS = C.QUICK_REPLY_MAX_ITEMS;
  const MAX_TITLE = C.QUICK_REPLY_MAX_TITLE;
  const MAX_TEXT = C.QUICK_REPLY_MAX_TEXT;

  function checkItem(it) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) return '항목이 객체가 아닙니다';
    if (typeof it.title !== 'string') return 'title이 문자열이 아닙니다';
    if (it.title.trim() === '') return 'title이 비어 있습니다';
    if (it.title.length > MAX_TITLE) return 'title이 ' + MAX_TITLE + '자를 넘습니다';
    if (typeof it.text !== 'string') return 'text가 문자열이 아닙니다';
    if (it.text.trim() === '') return 'text가 비어 있습니다';
    if (it.text.length > MAX_TEXT) return 'text가 ' + MAX_TEXT + '자를 넘습니다';
    if (it.id !== undefined && it.id !== null && typeof it.id !== 'string') return 'id가 문자열이 아닙니다';
    if (it.tags !== undefined && it.tags !== null &&
        (!Array.isArray(it.tags) || it.tags.some(function (t) { return typeof t !== 'string'; }))) {
      return 'tags가 문자열 배열이 아닙니다';
    }
    return null;
  }

  function normalize(it) {
    return {
      id: typeof it.id === 'string' && it.id !== '' ? it.id : undefined,
      title: it.title,
      text: it.text,
      tags: Array.isArray(it.tags) ? it.tags.slice() : []
    };
  }

  function validateImport(parsed) {
    let list = null;
    if (Array.isArray(parsed)) list = parsed;
    else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) {
      if (parsed.version !== 1) return { ok: false, errors: [{ index: -1, reason: 'version이 1이 아닙니다(지원하는 형식은 version 1뿐입니다)' }] };
      list = parsed.items;
    }
    if (!list) return { ok: false, errors: [{ index: -1, reason: '{"version":1,"items":[...]} 또는 항목 배열이 아닙니다' }] };
    if (list.length > MAX_ITEMS) return { ok: false, errors: [{ index: -1, reason: '항목이 ' + MAX_ITEMS + '개를 넘습니다(' + list.length + '개)' }] };
    const errors = [];
    list.forEach(function (it, index) {
      const reason = checkItem(it);
      if (reason) errors.push({ index: index, reason: reason });
    });
    if (errors.length) return { ok: false, errors: errors };
    return { ok: true, items: list.map(normalize) };
  }

  // existing은 저장된 항목(id 있음), incoming은 validateImport를 통과한 항목.
  function mergeImport(existing, incoming, mode, newId) {
    // 가져온 목록 안에서 id가 겹치면 뒤쪽 항목에 새 id를 준다(수정·삭제가 둘 다에 걸리지 않게).
    const seen = new Set();
    const withId = incoming.map(function (it) {
      const id = it.id && !seen.has(it.id) ? it.id : newId();
      seen.add(id);
      return Object.assign({}, it, { id: id });
    });
    if (mode === 'replace') return { items: withId, added: withId.length, changed: 0 };
    const items = existing.slice();
    let added = 0;
    let changed = 0;
    withId.forEach(function (it) {
      const at = items.findIndex(function (e) { return e.id === it.id; });
      if (at >= 0) { items[at] = it; changed++; }
      else { items.push(it); added++; }
    });
    return { items: items, added: added, changed: changed };
  }

  function exportFileName(date) {
    const p = function (n) { return String(n).padStart(2, '0'); };
    return 'quick-replies-' + date.getFullYear() + p(date.getMonth() + 1) + p(date.getDate()) + '.json';
  }

  root.QUICK_REPLY_LIMITS = { MAX_ITEMS: MAX_ITEMS, MAX_TITLE: MAX_TITLE, MAX_TEXT: MAX_TEXT };
  root.validateImport = validateImport;
  root.mergeImport = mergeImport;
  root.exportFileName = exportFileName;
})(typeof module !== 'undefined' && module.exports ? module.exports : (self.MBX = self.MBX || {}));
