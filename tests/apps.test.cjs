const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../JS/Zentral.uc.js'), 'utf8');
const classSource = source.slice(source.indexOf('class ZentralApps {'), source.indexOf('class ZentralTabGroups {'));
const constantSource = source.slice(source.indexOf('const Constants = {'), source.indexOf('const WELL_KNOWN_SERVICES ='));
const geometrySource = source.slice(source.indexOf('const ZentralGeometryBuiltin ='), source.indexOf('class ZentralApps {'));

class Events {
  listeners = new Map();
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatch(type, event = {}) {
    event.target ??= this;
    for (const fn of [...(this.listeners.get(type) || [])]) fn(event);
  }
}

class Element extends Events {
  children = [];
  dataset = {};
  attrs = new Map();
  className = '';
  style = {
    setProperty(name, value) { this[name] = String(value); },
    removeProperty(name) { delete this[name]; },
    getPropertyValue(name) { return this[name] || ''; },
  };
  constructor(tag = 'div') {
    super();
    this.tagName = tag;
    if (tag === 'browser') {
      this.progressListeners = new Set();
      this.webProgress = { isLoadingDocument: false };
    }
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (name) => { if (!this.classList.contains(name)) this.className += ` ${name}`; },
      remove: (name) => { this.className = this.className.split(/\s+/).filter(x => x !== name).join(' '); },
    };
  }
  get isConnected() { return this.tagName === 'document' || !!this.parentNode?.isConnected; }
  get parentElement() { return this.parentNode; }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
  get previousSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) - 1] || null; }
  get offsetHeight() { return 40; }
  get scrollWidth() { return 200; }
  get clientWidth() { return 200; }
  appendChild(el) {
    if (el.tagName === 'fragment') { for (const child of [...el.children]) this.appendChild(child); return el; }
    el.remove(); this.children.push(el); el.parentNode = this; return el;
  }
  append(...els) { els.forEach(el => this.appendChild(el)); }
  prepend(el) { this.insertBefore(el, this.firstChild); }
  insertBefore(el, ref) {
    el.remove();
    const index = ref ? this.children.indexOf(ref) : this.children.length;
    this.children.splice(index, 0, el); el.parentNode = this; return el;
  }
  removeChild(el) { el.remove(); }
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  replaceChildren(...els) { for (const child of [...this.children]) child.remove(); this.append(...els); }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  removeAttribute(name) { this.attrs.delete(name); }
  hasAttribute(name) { return this.attrs.has(name); }
  contains(el) { return this === el || this.children.some(child => child.contains(el)); }
  matches(selector) {
    if (selector === ':hover') return false;
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector === 'browser') return this.tagName === 'browser';
    const match = selector.match(/^\.([\w-]+)(?:\[data-app-id(?:="(.*)")?\])?$/);
    return !!match && this.classList.contains(match[1]) && (!selector.includes('[data-app-id') ||
      (match[2] === undefined ? this.dataset.appId !== undefined : this.dataset.appId === match[2]));
  }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(x => x.trim());
    const result = [];
    const visit = el => {
      for (const child of el.children) {
        if (selectors.some(s => child.matches(s))) result.push(child);
        visit(child);
      }
    };
    visit(this); return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  loadURI(uri) { this.loadedURI = uri.spec; this.currentURI = uri; this.webProgress.isLoadingDocument = true; }
  addProgressListener(listener) { this.progressListeners.add(listener); }
  removeProgressListener(listener) { this.progressListeners.delete(listener); }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  blur() { this.focused = false; }
  getBoundingClientRect() {
    if (this.rect) return this.rect;
    const panel = this.id === 'zen-app-panel-root';
    const width = panel ? parseFloat(this.style.width) || 240 : 240;
    const height = panel ? parseFloat(this.style.height) || 600 : 600;
    const top = panel ? parseFloat(this.style.top) || 40 : 40;
    const left = panel ? parseFloat(this.style.left) || 0 : 0;
    return { width, height, top, bottom: top + height, left, right: left + width };
  }
}

function harness(apps = [{ id: 'first', url: 'https://example.com', title: 'Example' }]) {
  const document = new Element('document');
  document.documentElement = document.appendChild(new Element('html'));
  document.head = document.documentElement.appendChild(new Element('head'));
  document.body = document.documentElement.appendChild(new Element('body'));
  document.createElement = document.createXULElement = tag => new Element(tag);
  document.createDocumentFragment = () => new Element('fragment');
  document.getElementById = id => document.querySelector(`#${id}`);
  for (const id of ['tabContextMenu', 'zen-toolbar-background', 'zen-browser-background', 'sidebar-box']) {
    const el = document.body.appendChild(new Element()); el.id = id;
  }
  const tabContainer = document.getElementById('sidebar-box').appendChild(new Element());
  const window = new Events();
  Object.assign(window, { innerWidth: 1200, innerHeight: 800 });
  let id = 0;
  const timers = new Map();
  const frames = new Map();
  const intervals = new Map();
  const observers = [];
  const prefObservers = new Map();
  const prefs = new Map([
    ['zen.workspace.apps.sidebar.apps', JSON.stringify(apps)],
    ['zen.workspace.apps.sidebar.enabled', true],
    ['zen.workspace.apps.sidebar.max_apps', 21],
    ['zen.workspace.apps.sidebar.animation_speed', 450],
    ['zen.workspace.apps.sidebar.animation_type', 'slide'],
  ]);
  class Observer {
    targets = new Set();
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target) { this.targets.add(target); }
    disconnect() { this.targets.clear(); }
  }
  window.MutationObserver = Observer;
  const errors = [];
  const context = vm.createContext({
    window, document, URL, URLSearchParams, Map, Set, ResizeObserver: Observer, MutationObserver: Observer,
    ChromeUtils: { generateQI: () => function () { return this; } },
    Ci: { nsIWebProgressListener: { STATE_START: 1, STATE_STOP: 2 }, nsIWebProgress: { NOTIFY_STATE_WINDOW: 1, NOTIFY_STATE_NETWORK: 2, NOTIFY_LOCATION: 4 } },
    gBrowser: { tabContainer }, performance: { now: () => 100 },
    createSVGElement: () => new Element('svg'), SVG_STRINGS: {}, WELL_KNOWN_SERVICES: {},
    getComputedStyle: () => ({ paddingTop: '0', paddingBottom: '0', rowGap: '0', position: 'relative' }),
    Core: { getPref: (key, fallback) => prefs.has(key) ? prefs.get(key) : fallback,
      setPref: (key, value) => prefs.set(key, value), getNativePref: (_, fallback) => fallback,
      log() {}, emit() {}, updateEffectiveTheme() {} },
    Services: { io: { newURI: url => ({ spec: url }) },
      scriptSecurityManager: { createContentPrincipal: uri => ({ uri }) },
      prefs: { addObserver(key, fn) {
        if (!prefObservers.has(key)) prefObservers.set(key, new Set()); prefObservers.get(key).add(fn);
      }, removeObserver(key, fn) { prefObservers.get(key)?.delete(fn); } } },
    setTimeout: (fn, delay) => { timers.set(++id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame: fn => { frames.set(++id, fn); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    setInterval: fn => { intervals.set(++id, fn); return id; },
    clearInterval: id => intervals.delete(id),
    console: { error: (...args) => errors.push(args), warn() {} },
  });
  const Klass = vm.runInContext(`${constantSource}\n${geometrySource}\n${classSource}\nZentralApps`, context);
  const instance = new Klass();
  const runTimers = async delay => {
    const pending = [...timers].filter(([, timer]) => delay === undefined || timer.delay === delay);
    for (const [key, { fn }] of pending) { if (timers.delete(key)) fn(); }
    await Promise.resolve();
  };
  const runFrames = () => {
    const pending = [...frames]; frames.clear(); for (const [, fn] of pending) fn();
  };
  return { instance, document, window, prefs, timers, frames, intervals, observers, prefObservers, errors, runTimers, runFrames };
}

test('hot unload cancels startup preload and clears UI state before reinitializing', async () => {
  const h = harness();
  h.instance.init();
  h.instance.openPanel({ id: 'first', url: 'https://example.com', title: 'Example' });
  h.instance.scheduleUtilityCollapse();
  h.instance.destroy();
  await h.runTimers();
  assert.equal(h.errors.length, 0);
  assert.equal(h.document.documentElement.hasAttribute('zentral-app-panel-open'), false);
  assert.equal(h.instance.isPanelOpen(), false);
  assert.equal(h.timers.size, 0);
  assert.equal(h.frames.size, 0);
  assert.equal(h.intervals.size, 0);
  h.instance.init();
  assert.equal(h.instance.isPanelOpen(), false);
});

test('destroy disconnects every owned observer and listener on persistent browser nodes', () => {
  const h = harness();
  h.instance.init();
  h.instance.destroy();
  assert.equal(h.observers.filter(observer => observer.targets.size).length, 0);
  for (const id of ['tabContextMenu', 'zen-toolbar-background', 'zen-browser-background']) {
    const el = h.document.getElementById(id);
    assert.equal([...el.listeners.values()].reduce((n, entries) => n + entries.size, 0), 0, id);
  }
  assert.equal([...h.window.listeners.values()].reduce((n, entries) => n + entries.size, 0), 0);
});

test('calling init twice does not duplicate observers or schedule extra startup work', () => {
  const h = harness();
  h.instance.init();
  const observerCount = h.observers.length;
  const timerCount = h.timers.size;
  h.instance.init();
  assert.equal(h.observers.length, observerCount);
  assert.equal(h.timers.size, timerCount);
});

test('background browser creation never displays a second app inside the open panel', () => {
  const h = harness();
  h.instance.createContainers();
  h.instance.openPanel({ id: 'first', url: 'https://example.com' });
  const { browser } = h.instance.getOrCreateAppBrowser({ id: 'second', url: 'https://second.example' });
  assert.equal(browser.style.display, 'none');
  const first = h.document.getElementById('zen-app-panel-slider').querySelector('browser');
  assert.equal(first.style.display, '');
});

test('closing a panel before its opening frame cannot expand or reveal it again', () => {
  const h = harness();
  h.instance.createContainers();
  h.instance.openPanel({ id: 'first', url: 'https://example.com' });
  h.instance.closePanel();
  h.runFrames();
  assert.equal(h.document.documentElement.hasAttribute('zentral-vb-expanded'), false);
  assert.equal(h.document.getElementById('zen-app-panel-slider').style.transform, 'translateX(-100%)');
});

test('preload sequence skips apps removed during its stagger delay', async () => {
  const h = harness([
    { id: 'first', url: 'https://example.com' },
    { id: 'second', url: 'https://second.example', preload: true },
  ]);
  h.instance.createContainers();
  h.instance.loadApps();
  const done = h.instance.preloadAppsSequence();
  h.instance.removeApp('second');
  await h.runTimers(1500);
  await h.runTimers(1500);
  await done;
  assert.equal(h.document.getElementById('zen-app-panel-slider').querySelectorAll('browser').length, 1);
});

test('destroy stops a running preload sequence even when the same instance restarts', async () => {
  const h = harness([
    { id: 'first', url: 'https://example.com' },
    { id: 'second', url: 'https://second.example', preload: true },
  ]);
  h.instance.init();
  const done = h.instance.preloadAppsSequence();
  h.instance.destroy();
  h.instance.init();
  await h.runTimers(1500);
  await h.runTimers(1500);
  await done;
  assert.equal(h.document.getElementById('zen-app-panel-slider').querySelectorAll('browser').length, 0);
});

test('malformed app titles cannot prevent rendering other saved apps', () => {
  const h = harness([{ id: 'first', url: 'https://example.com', title: 123 }]);
  assert.doesNotThrow(() => h.instance.init());
  h.instance.repositionGrid();
  assert.equal(h.document.getElementById('zen-app-btn-first').title, 'Example');
});

test('invalid and duplicate saved utility slots still leave both controls available', () => {
  const h = harness();
  h.prefs.set('zen.workspace.apps.sidebar.utility_order', '["unknown","unknown","unknown","unknown"]');
  h.instance.init();
  h.instance.repositionGrid();
  assert.ok(h.document.getElementById('zentral-utility-settings-btn'));
  assert.ok(h.document.getElementById('zentral-utility-autohide-btn'));
});

test('external app removal closes its panel and releases the old browser', async () => {
  const h = harness();
  h.instance.init();
  h.instance.openPanel({ id: 'first', url: 'https://example.com' });
  const browser = h.document.getElementById('zen-app-panel-slider').querySelector('browser');
  h.prefs.set('zen.workspace.apps.sidebar.apps', '[]');
  h.instance.loadApps();
  await h.runTimers(470);
  assert.equal(h.instance.isPanelOpen(), false);
  assert.equal(browser.isConnected, false);
  assert.equal(h.intervals.size, 0);
});

test('changing a saved app URL replaces its browser while unrelated edits retain it', () => {
  const h = harness();
  h.instance.init();
  h.instance.openPanel({ id: 'first', url: 'https://example.com' });
  const old = h.document.getElementById('zen-app-panel-slider').querySelector('browser');
  h.prefs.set('zen.workspace.apps.sidebar.apps', '[{"id":"first","url":"https://example.com","title":"Renamed"}]');
  h.instance.loadApps();
  assert.equal(old.isConnected, true);
  h.prefs.set('zen.workspace.apps.sidebar.apps', '[{"id":"first","url":"https://new.example"}]');
  h.instance.loadApps();
  h.instance.refreshApp('first');
  assert.equal(old.isConnected, false);
  assert.equal(h.document.getElementById('zen-app-panel-slider').querySelector('browser').loadedURI, 'https://new.example');
});

test('duplicate saved IDs cannot create tiles that control the same browser', () => {
  const h = harness([
    { id: 'first', url: 'https://example.com' },
    { id: 'first', url: 'https://different.example' },
  ]);
  h.instance.init();
  h.instance.repositionGrid();
  const tiles = h.document.querySelectorAll('.zen-app-tile[data-app-id]');
  assert.equal(tiles.length, 1);
  h.instance.saveApps();
  assert.equal(JSON.parse(h.prefs.get('zen.workspace.apps.sidebar.apps'))[0].url, 'https://example.com');
});

test('InstaPeek leaves settings shortcut recording untouched', () => {
  const h = harness();
  h.instance.createContainers();
  h.instance.openPanel({ id: 'first', url: 'https://example.com' });
  const modal = h.document.body.appendChild(new Element());
  modal.id = 'zentral-settings-modal';
  modal.setAttribute('data-open', 'true');
  let prevented = false;
  h.instance.handleInstaPeekKeyDown({
    key: 'q', code: 'KeyQ', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false,
    preventDefault() { prevented = true; }, stopPropagation() {},
  });
  assert.equal(prevented, false);
  assert.equal(h.document.getElementById('zen-app-panel-root').hasAttribute('data-insta-peek'), false);
});

test('shortcut matching accepts arrow names saved by the settings recorder', () => {
  const h = harness();
  for (const direction of ['Up', 'Down', 'Left', 'Right']) {
    assert.equal(h.instance.isShortcutMatch({
      key: `Arrow${direction}`, code: `Arrow${direction}`,
      ctrlKey: false, altKey: true, shiftKey: false, metaKey: false,
    }, `Alt+${direction}`), true, direction);
  }
});

test('resizing an expanded panel continues from its visible width without a jump', () => {
  const h = harness([{ id: 'first', url: 'https://example.com', width: 350 }]);
  h.instance.init();
  h.instance.openPanel({ id: 'first', url: 'https://example.com', width: 350 });
  h.instance.toggleExpand();
  assert.equal(h.document.getElementById('zen-app-panel-root').style.width, '936px');
  h.instance.startResize({ button: 0, clientX: 500, preventDefault() {} });
  h.instance.onDrag({ clientX: 510 });
  assert.equal(h.document.getElementById('zen-app-panel-root').style.width, '946px');
});

test('upstream app options survive save and reload', () => {
  const h = harness([{ id: 'first', url: 'https://example.com', mobile: true, zoom: 1.4, flipSide: true }]);
  h.instance.init();
  h.instance.saveApps();
  const [app] = JSON.parse(h.prefs.get('zen.workspace.apps.sidebar.apps'));
  assert.equal(app.mobile, true);
  assert.equal(app.zoom, 1.4);
  assert.equal(app.flipSide, true);
});

test('opening docked and floating panels keeps the custom bar expansion synchronized', () => {
  const h = harness();
  h.instance.init();
  h.instance.openPanel({ id: 'first', url: 'https://example.com' });
  h.runFrames();
  assert.equal(h.document.documentElement.getAttribute('zentral-vb-expanded'), 'true');
  h.instance.detachPanel();
  h.instance.closePanel();
  h.instance.openPanel({ id: 'first', url: 'https://example.com' });
  assert.equal(h.document.documentElement.getAttribute('zentral-vb-expanded'), 'true');
});

test('page loads use the latest zoom after preference records have been replaced', () => {
  const h = harness([{ id: 'first', url: 'https://example.com', zoom: 1.2 }]);
  h.instance.init();
  h.instance.refreshApp('first');
  const browser = h.document.querySelector('browser');
  h.prefs.set('zen.workspace.apps.sidebar.apps', '[{"id":"first","url":"https://example.com","zoom":2}]');
  h.instance.loadApps();
  browser.dispatch('load');
  assert.equal(browser.fullZoom, 2);
});

test('removing an app detaches its Gecko progress listener and loading timer', () => {
  const h = harness();
  h.instance.init();
  h.instance.openPanel({ id: 'first', url: 'https://example.com' });
  const browser = h.document.querySelector('browser');
  assert.equal(browser.progressListeners.size, 1);
  h.instance.removeApp('first');
  assert.equal(browser.progressListeners.size, 0);
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 8000).length, 0);
});

for (const gesture of ['drag', 'resize']) {
  test(`destroy cancels active floating ${gesture} handlers and temporary UI timers`, () => {
    const h = harness();
    h.instance.init();
    h.instance.openPanel({ id: 'first', url: 'https://example.com' });
    h.instance.detachPanel();
    const event = { button: 0, clientX: 300, clientY: 100, preventDefault() {}, stopPropagation() {} };
    if (gesture === 'drag') h.instance.beginDetachGesture(event);
    else h.instance.startFloatResize('se', event);
    h.instance.destroy();
    assert.equal([...h.window.listeners.values()].reduce((n, entries) => n + entries.size, 0), 0);
    assert.equal(h.timers.size, 0);
  });
}

test('pending redock cannot modify a replacement UI after destroy and reinit', async () => {
  const h = harness();
  h.instance.init();
  h.instance.openPanel({ id: 'first', url: 'https://example.com' });
  h.instance.detachPanel();
  const done = h.instance.redockPanel('sidebar');
  h.instance.destroy();
  h.instance.init();
  const root = h.document.getElementById('zen-app-panel-root');
  await h.runTimers(250);
  await done;
  assert.equal(root.style.width, undefined);
  assert.equal(h.instance.isPanelOpen(), false);
});

test('expanding an app docked opposite the sidebar uses the free content width', () => {
  const h = harness([{ id: 'first', url: 'https://example.com', flipSide: true }]);
  h.instance.init();
  h.instance.openPanel({ id: 'first', url: 'https://example.com', flipSide: true });
  h.instance.toggleExpand();
  assert.equal(h.document.getElementById('zen-app-panel-root').style.width, '936px');
});

test('opposite docking in vertical-bar mode stays outside the native sidebar', () => {
  const h = harness([{ id: 'first', url: 'https://example.com', flipSide: true }]);
  h.prefs.set('zen.workspace.apps.sidebar.placement', 'vertical-bar');
  h.instance.init();
  h.instance.openPanel({ id: 'first', url: 'https://example.com', flipSide: true });
  assert.equal(h.document.getElementById('zen-app-panel-root').style.left, '252px');
});

test('navbar address shortcut does not steal keyboard focus from settings', () => {
  const h = harness();
  h.prefs.set('zen.workspace.apps.sidebar.show_navbar', true);
  h.instance.init();
  h.instance.openPanel({ id: 'first', url: 'https://example.com' });
  const modal = h.document.body.appendChild(new Element());
  modal.id = 'zentral-settings-modal'; modal.setAttribute('data-open', 'true');
  let prevented = false;
  h.window.dispatch('keydown', { key: 'l', ctrlKey: true, metaKey: false,
    preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.equal(prevented, false);
});

test('saving a navbar address without a scheme keeps a valid app URL', () => {
  const h = harness(); h.instance.init();
  h.instance.openPanel({ id: 'first', url: 'https://example.com' });
  h.document.querySelector('.zen-app-nav-url-input').value = 'new.example.com/path';
  h.instance.navUpdateAppUrl();
  assert.equal(JSON.parse(h.prefs.get('zen.workspace.apps.sidebar.apps'))[0].url, 'https://new.example.com/path');
});

test('saving an invalid navbar address preserves the previous app URL', () => {
  const h = harness(); h.instance.init();
  h.instance.openPanel({ id: 'first', url: 'https://example.com' });
  h.document.querySelector('.zen-app-nav-url-input').value = 'https://bad host';
  h.instance.navUpdateAppUrl();
  assert.equal(JSON.parse(h.prefs.get('zen.workspace.apps.sidebar.apps'))[0].url, 'https://example.com');
});
