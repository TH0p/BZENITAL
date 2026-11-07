const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const source = readFileSync(join(__dirname, '../JS/zentral_logger.uc.js'), 'utf8');

function target() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(name, fn, options) {
      const rows = listeners.get(name) || [];
      rows.push({ fn, options }); listeners.set(name, rows);
    },
    removeEventListener(name, fn) {
      listeners.set(name, (listeners.get(name) || []).filter(row => row.fn !== fn));
    },
    dispatchEvent(event) {
      for (const { fn, options } of [...(listeners.get(event.type) || [])]) {
        fn(event); if (options?.once) this.removeEventListener(event.type, fn);
      }
    },
  };
}

function harness({ enabled = true, full = false, ready = 'complete' } = {}) {
  const prefs = new Map([
    ['zen.workspace.zentral.debug', enabled], ['zen.workspace.zentral.debug.full', full],
  ]);
  const prefObservers = new Set();
  const consoleListeners = new Set();
  const observers = [];
  const window = target();
  const document = Object.assign(target(), {
    readyState: ready, body: target(),
    documentElement: { attributes: [], getAttribute() { return null; } },
    getElementById() { return null; }, querySelectorAll() { return []; }, querySelector() { return null; },
  });
  let nativeCalls = 0;
  const splitter = { splitTabs() { nativeCalls++; return 'native-result'; } };
  window.gZenViewSplitter = splitter;
  const nativeConsole = Object.fromEntries(['log', 'warn', 'error', 'info', 'debug'].map(k => [k, () => {}]));
  const context = vm.createContext({ window, document, console: nativeConsole,
    Services: {
      prefs: {
        getBoolPref(key, fallback) { return prefs.has(key) ? prefs.get(key) : fallback; },
        addObserver(key, observer) { prefObservers.add(observer); },
        removeObserver(key, observer) { prefObservers.delete(observer); },
      },
      console: {
        registerListener(listener) { consoleListeners.add(listener); },
        unregisterListener(listener) { consoleListeners.delete(listener); },
      },
    },
    ChromeUtils: { generateQI() { return function () {}; } },
    Ci: { nsIScriptError: class {}, nsIConsoleMessage: class {} },
    Element: class {}, HTMLElement: class {},
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.connected = false; observers.push(this); }
      observe() { this.connected = true; } disconnect() { this.connected = false; }
    },
    CustomEvent: class { constructor(type) { this.type = type; } },
    alert() {},
  });
  const load = () => vm.runInContext(source, context, { filename: 'zentral_logger.uc.js' });
  load();
  return { context, window, document, prefs, prefObservers, observers, consoleListeners, load,
    nativeCalls: () => nativeCalls,
    setEnabled(value) {
      prefs.set('zen.workspace.zentral.debug', value);
      for (const observer of prefObservers) observer.observe(null, 'nsPref:changed', 'zen.workspace.zentral.debug');
    },
  };
}

test('registers and unregisters the Gecko console listener', () => {
  const h = harness();
  assert.equal(h.consoleListeners.size, 1);
  h.window._zentralLoggerCleanup();
  assert.equal(h.consoleListeners.size, 0);
});

test('arbitrary console tags and unformattable values cannot break logging', () => {
  const h = harness();
  assert.doesNotThrow(() => h.context.console.log('[broken(] message'));
  const hostile = { toString() { throw new Error('bad stringify'); } }; hostile.self = hostile;
  assert.doesNotThrow(() => h.window.ZentralLogger.log('Core', hostile));
  assert.ok(h.window.ZentralLogger.entries.length >= 2);
});

test('layout records respect the layout module even for a component named AppsGrid', () => {
  const h = harness();
  h.prefs.set('zen.workspace.zentral.debug.layout', true);
  h.window.ZentralLogger.clear();
  h.window.ZentralLogger.layout('AppsGrid', { horizontal: true });
  assert.equal(h.window.ZentralLogger.entries.length, 1);
  assert.doesNotThrow(() => {
    const cycle = {}; cycle.self = cycle; h.window.ZentralLogger.layout('Root', cycle);
  });
});

test('disabling diagnostics clears prior events and blocks programmatic exports', () => {
  const h = harness();
  h.window.ZentralLogger.log('Core', 'PRIVATE previous event');
  h.setEnabled(false);
  assert.equal(h.window.ZentralLogger.generateLogString(), '');
  assert.equal(h.window._zentralLoggerRingBuffer.length, 0);
  h.setEnabled(true);
  assert.ok(!h.window.ZentralLogger.generateLogString().includes('PRIVATE'));
});

test('bounds the retained size of large diagnostic events', () => {
  const h = harness(); h.window.ZentralLogger.clear();
  for (let i = 0; i < 300; i++) h.window.ZentralLogger.log('Core', String(i) + 'x'.repeat(50000));
  const entries = h.window.ZentralLogger.entries;
  assert.ok(entries.every(entry => entry.length <= 10000));
  assert.ok(entries.join('\n').length <= 2100000);
  assert.ok(entries.at(-1).includes('299'));
});

test('hot reload removes capture/DOMContentLoaded listeners and unload releases resources', () => {
  const h = harness({ ready: 'loading' });
  h.load();
  assert.equal(h.window.listeners.get('ZentralCaptureLog').length, 1);
  assert.equal(h.window.listeners.get('DOMContentLoaded').length, 1);
  h.window.dispatchEvent({ type: 'DOMContentLoaded' });
  assert.ok(h.observers.some(observer => observer.connected));
  h.window.dispatchEvent({ type: 'unload' });
  assert.ok(h.observers.every(observer => !observer.connected));
  assert.equal(h.consoleListeners.size, 0);
  assert.equal(h.window.listeners.get('ZentralCaptureLog').length, 0);
});

test('diagnostic wrappers always delegate even when formatting receives unusual inputs', () => {
  const h = harness(); h.prefs.set('zen.workspace.zentral.debug.tabs', true);
  assert.equal(h.window.gZenViewSplitter.splitTabs({ unexpected: true }), 'native-result');
  assert.equal(h.nativeCalls(), 1);
});

test('failed exports close converter and file streams', () => {
  const h = harness();
  let closedFile = 0, closedConverter = 0;
  const file = { path: 'test-only/logs', exists() { return true; },
    isDirectory() { return true; }, clone() { return { ...this }; },
    append(name) { this.path += '/' + name; }, createUnique() {},
  };
  h.context.Services.dirsvc = { get() { return file; } };
  h.context.Ci.nsIFile = { DIRECTORY_TYPE: 1, NORMAL_FILE_TYPE: 0 };
  h.context.Cc = {
    '@mozilla.org/network/file-output-stream;1': { createInstance() {
      return { init() {}, close() { closedFile++; } };
    } },
    '@mozilla.org/intl/converter-output-stream;1': { createInstance() {
      return { init() {}, writeString() { throw new Error('disk full'); }, close() { closedConverter++; } };
    } },
  };
  h.window.ZentralLogger.export();
  assert.equal(closedFile, 1);
  assert.equal(closedConverter, 1);
});

test('cleanup preserves wrappers installed by another module after diagnostics', () => {
  const h = harness();
  const laterConsole = () => {};
  const laterSplitter = () => 'other-module-result';
  h.context.console.log = laterConsole;
  h.window.gZenViewSplitter.splitTabs = laterSplitter;
  h.window._zentralLoggerCleanup();
  assert.equal(h.context.console.log, laterConsole);
  assert.equal(h.window.gZenViewSplitter.splitTabs, laterSplitter);
});

test('exports within the same timestamp preserve both log files', () => {
  const h = harness();
  const files = new Map();
  const file = { path: 'test-only', exists() { return true; },
    clone() { return { ...this }; }, append(name) { this.path += '/' + name; },
    createUnique() {
      const base = this.path; let suffix = 0;
      while (files.has(this.path)) this.path = base + '-' + (++suffix);
      files.set(this.path, '');
    },
  };
  h.context.Date = class extends Date { constructor() { super('2026-11-07T12:00:00Z'); } };
  h.context.Services.dirsvc = { get() { return file; } };
  h.context.Ci.nsIFile = { DIRECTORY_TYPE: 1, NORMAL_FILE_TYPE: 0 };
  h.context.Cc = {
    '@mozilla.org/network/file-output-stream;1': { createInstance() {
      return { init(target) { this.path = target.path; files.set(this.path, ''); }, close() {} };
    } },
    '@mozilla.org/intl/converter-output-stream;1': { createInstance() {
      return { init(stream) { this.path = stream.path; },
        writeString(value) { files.set(this.path, files.get(this.path) + value); }, close() {},
      };
    } },
  };
  h.window.ZentralLogger.export();
  h.window.ZentralLogger.export();
  assert.equal(files.size, 2);
  assert.ok([...files.values()].every(value => value.includes('End of export.')));
});

test('closed popups release their mutation observers and can be observed when reopened', () => {
  const h = harness();
  const active = () => h.observers.filter(observer => observer.connected).length;
  const before = active();
  const popup = { tagName: 'menupopup', id: 'test-popup', children: [] };
  h.window.dispatchEvent({ type: 'popupshowing', target: popup });
  assert.equal(active(), before + 1);
  h.window.dispatchEvent({ type: 'popuphidden', target: popup });
  assert.equal(active(), before);
  h.window.dispatchEvent({ type: 'popupshowing', target: popup });
  assert.equal(active(), before + 1);
});
