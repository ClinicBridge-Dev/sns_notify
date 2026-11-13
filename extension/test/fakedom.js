// 테스트 전용 최소 DOM. content script 의 삽입·제거·Shadow DOM·이벤트 배선을 node 에서 확인하는 데 필요한 만큼만 흉내 낸다.
// 지원 선택자: 'tag', '.cls', '[attr]', '[attr="v"]' 와 그 조합(공백으로 이은 자손 선택자, 쉼표 목록은 지원하지 않는다).
'use strict';

class FakeEvent {
  constructor(type, init) {
    Object.assign(this, { bubbles: true, cancelable: true }, init || {});
    this.type = type;
    this.defaultPrevented = false;
    this.propagationStopped = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
  stopImmediatePropagation() { this.propagationStopped = true; this.immediateStopped = true; }
  composedPath() { return this._path || []; }
}

function matchesSimple(el, part) {
  if (!el || el.nodeType !== 1) return false;
  const re = /([a-zA-Z0-9-]+)|\.([a-zA-Z0-9_-]+)|\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]/g;
  let m;
  let any = false;
  while ((m = re.exec(part))) {
    any = true;
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    if (m[2] && el.classList.contains(m[2]) === false) return false;
    if (m[3]) {
      if (!el.hasAttribute(m[3])) return false;
      if (m[4] !== undefined && el.getAttribute(m[3]) !== m[4]) return false;
    }
  }
  return any;
}

function matches(el, selector) {
  const parts = selector.trim().split(/\s+/);
  if (!matchesSimple(el, parts[parts.length - 1])) return false;
  let i = parts.length - 2;
  let a = el.parentNode;
  while (i >= 0 && a) {
    if (matchesSimple(a, parts[i])) i--;
    a = a.parentNode;
  }
  return i < 0;
}

class Node {
  constructor(doc) { this.ownerDocument = doc; this.childNodes = []; this.parentNode = null; this.listeners = {}; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }
  get nextSibling() { if (!this.parentNode) return null; const s = this.parentNode.childNodes; return s[s.indexOf(this) + 1] || null; }
  get nextElementSibling() { let n = this.nextSibling; while (n && n.nodeType !== 1) n = n.nextSibling; return n; }
  get previousElementSibling() {
    if (!this.parentNode) return null;
    const s = this.parentNode.childNodes;
    for (let i = s.indexOf(this) - 1; i >= 0; i--) if (s[i].nodeType === 1) return s[i];
    return null;
  }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument || (n.host && n.host.isConnected); }
  appendChild(c) { return this.insertBefore(c, null); }
  insertBefore(c, ref) {
    if (c.parentNode) c.parentNode.removeChild(c);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
    c.parentNode = this;
    if (this.ownerDocument && this.ownerDocument._mutated) this.ownerDocument._mutated(this, [c], []);
    return c;
  }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    if (this.ownerDocument && this.ownerDocument._mutated) this.ownerDocument._mutated(this, [], [c]);
    return c;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  dispatchEvent(ev) { return dispatch(this, ev); }
  contains(n) { while (n) { if (n === this) return true; n = n.parentNode || (n.host || null); } return false; }
  addEventListener(t, f, opt) { const cap = opt === true || !!(opt && opt.capture); (this.listeners[t] = this.listeners[t] || []).push({ f, cap }); }
  removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((l) => l.f !== f); }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => n.childNodes.forEach((c) => { if (c.nodeType === 1) { if (matches(c, sel)) out.push(c); walk(c); } });
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.childNodes.slice().forEach((c) => this.removeChild(c)); if (v !== '' && v !== null && v !== undefined) this.appendChild(this.ownerDocument.createTextNode(String(v))); }
}

class Text extends Node {
  constructor(doc, data) { super(doc); this.nodeType = 3; this.data = data; }
  get length() { return this.data.length; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

class ClassList {
  constructor(el) { this.el = el; }
  _get() { return (this.el.className || '').split(/\s+/).filter(Boolean); }
  contains(c) { return this._get().indexOf(c) >= 0; }
  add(...cs) { const s = this._get(); cs.forEach((c) => { if (s.indexOf(c) < 0) s.push(c); }); this.el.className = s.join(' '); }
  remove(...cs) { this.el.className = this._get().filter((c) => cs.indexOf(c) < 0).join(' '); }
  toggle(c, on) { const has = this.contains(c); const want = on === undefined ? !has : !!on; if (want) this.add(c); else this.remove(c); return want; }
}

class Element extends Node {
  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = {}; this.style = {}; this.className = '';
    this.classList = new ClassList(this); this.disabled = false; this.value = ''; this.rect = null; this.shadowRoot = null;
  }
  setAttribute(k, v) { if (k === 'class') this.className = String(v); else this.attrs[k] = String(v); }
  getAttribute(k) { if (k === 'class') return this.className || null; return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  hasAttribute(k) { return k === 'class' ? !!this.className : Object.prototype.hasOwnProperty.call(this.attrs, k); }
  removeAttribute(k) { delete this.attrs[k]; }
  get id() { return this.attrs.id || ''; }
  set id(v) { this.attrs.id = v; }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) { if (v) this.attrs.hidden = ''; else delete this.attrs.hidden; }
  get innerText() { this.ownerDocument.textReads.push(this); return this.textContent; }
  closest(sel) { let n = this; while (n && n.nodeType === 1) { if (matches(n, sel)) return n; n = n.parentNode; } return null; }
  matches(sel) { return matches(this, sel); }
  attachShadow() { const r = new ShadowRoot(this.ownerDocument, this); this.shadowRoot = r; return r; }
  getBoundingClientRect() { const r = this.rect || { top: 0, left: 0, width: 100, height: 20 }; return Object.assign({ bottom: r.top + r.height, right: r.left + r.width }, r); }
  getClientRects() { return this.isConnected ? [this.getBoundingClientRect()] : []; }
  focus() { this.ownerDocument.activeElement = this; }
  blur() {}
  click() { dispatch(this, new FakeEvent('click')); }
  scrollIntoView() {}
}

class ShadowRoot extends Node {
  constructor(doc, host) { super(doc); this.nodeType = 11; this.host = host; }
}

// 대상에서 위로(그림자 경계를 넘어) 경로를 만든다. capture → target → bubble 순서로 호출한다.
function dispatch(target, ev) {
  const path = [];
  let n = target;
  while (n) { path.push(n); n = n.parentNode || n.host || null; }
  const doc = target.ownerDocument;
  if (doc && path[path.length - 1] === doc && doc.defaultView) path.push(doc.defaultView);
  ev.target = target; ev._path = path;
  const call = (node, capPhase) => {
    (node.listeners[ev.type] || []).slice().forEach((l) => { if (l.cap === capPhase && !ev.immediateStopped) l.f.call(node, ev); });
  };
  for (let i = path.length - 1; i >= 0 && !ev.propagationStopped; i--) call(path[i], true);
  for (let i = 0; i < path.length && !ev.propagationStopped; i++) { if (i > 0 && !ev.bubbles) break; call(path[i], false); }
  return !ev.defaultPrevented;
}

class Document extends Node {
  constructor() {
    super(null);
    this.ownerDocument = this; this.nodeType = 9; this.textReads = []; this.readyState = 'complete'; this.hidden = false;
    this.observers = [];
    this.documentElement = this.appendChild(new Element(this, 'html'));
    this.body = this.documentElement.appendChild(new Element(this, 'body'));
    this.activeElement = this.body;
  }
  createElement(t) { return new Element(this, t); }
  createTextNode(d) { return new Text(this, d); }
  // 실제 MutationObserver(documentElement subtree)처럼 문서 트리 안의 변화만 알린다. 떨어진 요소와 Shadow DOM 안은 알리지 않는다.
  _mutated(target, added, removed) {
    let n = target;
    while (n && n !== this) n = n.parentNode;
    if (n !== this) return;
    this.observers.forEach((o) => o._record({ target, addedNodes: added, removedNodes: removed }));
  }
}

function install(g) {
  const doc = new Document();
  const win = { listeners: {}, innerWidth: 1200, innerHeight: 800 };
  win.addEventListener = Node.prototype.addEventListener;
  win.removeEventListener = Node.prototype.removeEventListener;
  doc.defaultView = win;
  class MutationObserver {
    constructor(cb) { this.cb = cb; this.queue = []; doc.observers.push(this); }
    observe() { this.active = true; }
    disconnect() { this.active = false; }
    takeRecords() { const q = this.queue; this.queue = []; return q; }
    _record(r) { if (!this.active) return; this.queue.push(r); if (this.queue.length === 1) Promise.resolve().then(() => { const q = this.takeRecords(); if (q.length) this.cb(q, this); }); }
  }
  g.document = doc;
  g.window = win;
  g.MutationObserver = MutationObserver;
  g.requestAnimationFrame = (f) => setTimeout(f, 0);
  g.getComputedStyle = (el) => Object.assign({ flexDirection: 'column', overflow: 'visible', overflowY: 'visible', overflowX: 'visible' }, el.computed || {});
  g.Event = FakeEvent;
  return { doc, win, dispatch, FakeEvent };
}

module.exports = { install, dispatch, FakeEvent };
