const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../JS/Zentral.uc.js'), 'utf8');
const bootstrapStart = source.search(/  (?:const|let) Apps = new ZentralApps\(\);/);

function load({ delayed = true, values = {}, defaults = {}, coreOnly = false, readyState = 'complete', mediaDark = false, legacyMedia = false } = {}) {
  const prefObservers = new Set();
  const startupObservers = new Set();
  const events = new Map();
  const themeObservers = new Map();
  const mediaListeners = new Set();
  const mediaQuery = { matches: mediaDark };
  if (legacyMedia) {
    mediaQuery.addListener = fn => mediaListeners.add(fn);
    mediaQuery.removeListener = fn => mediaListeners.delete(fn);
  } else {
    mediaQuery.addEventListener = (_type, fn) => mediaListeners.add(fn);
    mediaQuery.removeEventListener = (_type, fn) => mediaListeners.delete(fn);
  }
  const node = () => ({ attrs: new Map(), setAttribute(key, value) { this.attrs.set(key, value); }, removeAttribute(key) { this.attrs.delete(key); } });
  const root = node();
  const tooltip = node();
  const slider = node();
  const prefs = {
    PREF_BOOL: 128, PREF_INT: 64, PREF_STRING: 32,
    prefHasUserValue: key => Object.hasOwn(values, key),
    getPrefType(key) {
      const value = Object.hasOwn(values, key) ? values[key] : defaults[key];
      return { boolean: 128, number: 64, string: 32 }[typeof value] || 0;
    },
    getBoolPref: key => Object.hasOwn(values, key) ? values[key] : defaults[key],
    getIntPref: key => Object.hasOwn(values, key) ? values[key] : defaults[key],
    getStringPref: key => Object.hasOwn(values, key) ? values[key] : defaults[key],
    addObserver: (branch, observer) => prefObservers.add({ branch, observer }),
    removeObserver(branch, observer) {
      for (const entry of prefObservers) if (entry.branch === branch && entry.observer === observer) prefObservers.delete(entry);
    },
  };
  for (const type of ['Bool', 'Int', 'String']) prefs[`set${type}Pref`] = (key, value) => {
    if (Object.hasOwn(defaults, key) && typeof defaults[key] !== typeof value) throw new Error('Preference type differs from default branch');
    values[key] = value;
    for (const { branch, observer } of [...prefObservers]) {
      if (key.startsWith(branch)) {
        if (typeof observer === 'function') observer(null, 'nsPref:changed', key);
        else observer.observe(null, 'nsPref:changed', key);
      }
    }
  };
  const window = {
    addEventListener(type, fn) { if (!events.has(type)) events.set(type, new Set()); events.get(type).add(fn); },
    removeEventListener: (type, fn) => events.get(type)?.delete(fn),
    matchMedia: () => mediaQuery,
  };
  const context = vm.createContext({
    window, console: { log() {}, warn() {}, error() {} }, URL, AbortController,
    setTimeout, clearTimeout, queueMicrotask,
    Services: { prefs, obs: {
      addObserver(fn, topic) {
        if (topic === 'browser-delayed-startup-finished') startupObservers.add(fn);
        else { if (!themeObservers.has(topic)) themeObservers.set(topic, new Set()); themeObservers.get(topic).add(fn); }
      },
      removeObserver(fn, topic) {
        if (topic === 'browser-delayed-startup-finished') startupObservers.delete(fn);
        else themeObservers.get(topic)?.delete(fn);
      },
    } },
    gBrowserInit: { delayedStartupFinished: delayed },
    document: { readyState, documentElement: root, getElementById(id) { return id === 'zentral-tabgroup-tooltip' ? tooltip : id === 'zen-app-panel-slider' ? slider : null; } },
  });
  const constants = source.slice(source.indexOf('  const Constants ='), source.indexOf('  const WELL_KNOWN_SERVICES ='));
  const core = source.slice(source.indexOf('  class ZentralCore {'), source.indexOf('  // Instantiate Core immediately'));
  const settings = coreOnly ? '' : source.slice(source.indexOf('  class ZentralSettings {'), bootstrapStart);
  vm.runInContext(`${constants}\n${core}\n${settings}\nthis.Core = new ZentralCore(); this.Constants = Constants;${coreOnly ? '' : ' this.SettingsClass = ZentralSettings;'}`, context);
  return { context, window, prefs, prefObservers, startupObservers, events, values, themeObservers, mediaListeners, mediaQuery, root, tooltip, slider };
}

test('Core reads values from the Firefox default preference branch', () => {
  const { context } = load({ coreOnly: true, defaults: { 'zen.workspace.apps.sidebar.enabled': false } });
  assert.equal(context.Core.getPref('zen.workspace.apps.sidebar.enabled'), false);
});

test('Core forwards external preference changes once and detaches on destroy', () => {
  const { context, prefs, prefObservers } = load({ coreOnly: true });
  const changes = [];
  context.Core.on('configChanged', data => changes.push(data));
  context.Core.init();
  prefs.setBoolPref('zen.workspace.apps.sidebar.enabled', false);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].key, 'zen.workspace.apps.sidebar.enabled');
  assert.equal(changes[0].value, false);
  context.Core.destroy();
  assert.equal(prefObservers.size, 0);
  prefs.setBoolPref('zen.workspace.apps.sidebar.enabled', true);
  assert.equal(changes.length, 1);
});

test('Numeric settings can be saved over string defaults declared by Sine dropdowns', () => {
  const { context } = load({ coreOnly: true, defaults: { 'zen.workspace.apps.sidebar.apps_per_row': '7' } });
  context.Core.setPref('zen.workspace.apps.sidebar.apps_per_row', 8);
  assert.equal(Number(context.Core.getPref('zen.workspace.apps.sidebar.apps_per_row')), 8);
});

test('Core construction leaves theme listeners and DOM untouched until init', () => {
  const env = load({ coreOnly: true, readyState: 'loading' });
  assert.equal(env.mediaListeners.size, 0);
  assert.equal(env.themeObservers.size, 0);
  assert.equal(env.prefObservers.size, 0);
  assert.equal(env.events.get('DOMContentLoaded')?.size || 0, 0);
  assert.equal(env.root.attrs.size, 0);
});

test('Core init synchronizes the root, tooltip and app slider with the effective theme', () => {
  const env = load({ coreOnly: true, mediaDark: true });
  const seen = [];
  env.context.Core.on('effective-theme-changed', event => seen.push(event.theme));
  env.context.Core.init();
  for (const element of [env.root, env.tooltip, env.slider]) assert.equal(element.attrs.get('zentral-effective-theme'), 'dark');
  env.prefs.setIntPref('layout.css.prefers-color-scheme.content-override', 1);
  for (const element of [env.root, env.tooltip, env.slider]) assert.equal(element.attrs.get('zentral-effective-theme'), 'light');
  assert.deepEqual(seen, ['dark', 'light']);
  env.context.Core.destroy();
});

test('Core destroy removes preference, media, observer and pending DOM-ready listeners', () => {
  const env = load({ coreOnly: true, readyState: 'loading' });
  env.context.Core.init();
  assert.equal(env.mediaListeners.size, 1);
  assert.equal(env.events.get('DOMContentLoaded')?.size, 1);
  env.context.Core.destroy();
  assert.equal(env.mediaListeners.size, 0);
  assert.equal(env.prefObservers.size, 0);
  assert.equal(env.events.get('DOMContentLoaded')?.size || 0, 0);
  for (const observers of env.themeObservers.values()) assert.equal(observers.size, 0);
  for (const element of [env.root, env.tooltip, env.slider]) assert.equal(element.attrs.has('zentral-effective-theme'), false);
  assert.equal(env.context.Core.listeners.size, 0);
});

test('Core theme tracking remains idempotent through repeated init and destroy', () => {
  const env = load({ coreOnly: true, readyState: 'loading' });
  env.context.Core.init(); env.context.Core.init();
  assert.equal(env.mediaListeners.size, 1);
  assert.equal(env.events.get('DOMContentLoaded')?.size, 1);
  env.context.Core.destroy(); env.context.Core.destroy(); env.context.Core.init();
  assert.equal(env.mediaListeners.size, 1);
  for (const observers of env.themeObservers.values()) assert.equal(observers.size, 1);
  assert.equal(env.events.get('DOMContentLoaded')?.size, 1);
  env.context.Core.destroy();
});

test('Core releases legacy matchMedia listeners on unload', () => {
  const env = load({ coreOnly: true, legacyMedia: true });
  env.context.Core.init();
  assert.equal(env.mediaListeners.size, 1);
  env.context.Core.destroy();
  assert.equal(env.mediaListeners.size, 0);
});

test('Core reacts to OS and browser theme notifications', () => {
  const env = load({ coreOnly: true }); env.context.Core.init();
  env.mediaQuery.matches = true;
  for (const callback of env.mediaListeners) callback();
  assert.equal(env.root.attrs.get('zentral-effective-theme'), 'dark');
  env.mediaQuery.matches = false;
  for (const observer of env.themeObservers.get('zen-theme-change')) observer.observe(null, 'zen-theme-change');
  assert.equal(env.root.attrs.get('zentral-effective-theme'), 'light');
  env.context.Core.destroy();
});

function boot(options) {
  const env = load(options);
  env.context.instances = [];
  env.context.failApps = options?.failApps || false;
  vm.runInContext(`
    class Module {
      constructor() { this.starts = 0; this.stops = 0; instances.push(this); }
      init() { this.starts++; if (failApps && this instanceof ZentralApps) throw new Error('app startup failed'); }
      destroy() { this.stops++; if (this.failDestroy) throw new Error('cleanup failed'); }
    }
    class ZentralApps extends Module {}
    class ZentralTabGroups extends Module {}
    ZentralSettings = class extends Module {};
  `, env.context);
  vm.runInContext(source.slice(bootstrapStart, source.lastIndexOf('})();')), env.context);
  return env;
}

test('Bootstrap Init is idempotent', () => {
  const { window } = boot();
  window.Zentral.Init();
  assert.equal(window.Zentral.Apps.starts, 1);
  window.Zentral.Destroy();
});

test('A failing Apps startup does not prevent groups or settings from initializing', () => {
  const { context, window } = boot({ failApps: true });
  assert.equal(context.instances[1].starts, 1);
  assert.equal(context.instances[2].starts, 1);
  assert.equal(context.instances[0].stops, 1);
  window.Zentral.Destroy();
});

test('Unloading before delayed startup cancels the old startup observer', () => {
  const { window, startupObservers, context } = boot({ delayed: false });
  const oldCallbacks = [...startupObservers];
  window.Zentral.Destroy();
  assert.equal(startupObservers.size, 0);
  const before = context.instances.reduce((total, instance) => total + instance.starts, 0);
  for (const callback of oldCallbacks) callback(window, 'browser-delayed-startup-finished');
  assert.equal(context.instances.reduce((total, instance) => total + instance.starts, 0), before);
});

test('A failing module cleanup still tears down all other modules', () => {
  const { window, context, events } = boot();
  window.Zentral.Apps.failDestroy = true;
  assert.doesNotThrow(() => window.Zentral.Destroy());
  assert.equal(window.Zentral, undefined);
  assert.equal(window.ZentralInitialized, false);
  assert.equal(context.instances[1].stops, 1);
  assert.equal(context.instances[2].stops, 1);
  assert.equal(events.get('unload')?.size || 0, 0);
});

test('Changing a module enable preference destroys then recreates its instance', async () => {
  const { window, prefs } = boot();
  const first = window.Zentral.Apps;
  prefs.setBoolPref('zen.workspace.apps.sidebar.enabled', false);
  await Promise.resolve();
  assert.equal(first.stops, 1);
  prefs.setBoolPref('zen.workspace.apps.sidebar.enabled', true);
  await Promise.resolve();
  assert.notEqual(window.Zentral.Apps, first);
  assert.equal(window.Zentral.Apps.starts, 1);
  window.Zentral.Destroy();
});

test('An external navigation-toolbar preference applies immediately to enabled Apps', async () => {
  const { window, prefs } = boot();
  let applications = 0;
  window.Zentral.Apps.applyNavbarPref = () => applications++;
  prefs.setBoolPref('zen.workspace.apps.sidebar.show_navbar', true);
  await Promise.resolve();
  assert.equal(applications, 1);
  window.Zentral.Destroy();
});

test('Navigation-toolbar preference changes do not revive disabled Apps', async () => {
  const { window, prefs } = boot();
  const apps = window.Zentral.Apps;
  let applications = 0;
  apps.applyNavbarPref = () => applications++;
  prefs.setBoolPref('zen.workspace.apps.sidebar.enabled', false);
  await Promise.resolve();
  prefs.setBoolPref('zen.workspace.apps.sidebar.show_navbar', true);
  await Promise.resolve();
  assert.equal(applications, 0);
  assert.equal(apps.stops, 1);
  assert.equal(apps.starts, 1);
  window.Zentral.Destroy();
});

test('Closing settings stops the shortcut recorder from intercepting browser keys', () => {
  const { context, events } = load();
  const handlers = new Map();
  const label = { textContent: '' };
  const input = { value: 'Alt+Q' };
  const button = {
    querySelector: () => label, setAttribute() {}, removeAttribute() {},
    addEventListener: (type, fn) => handlers.set(type, fn),
  };
  const settings = new context.SettingsClass();
  settings.modal = {
    querySelector: selector => selector === '#shortcut' ? button : input,
    addEventListener() {}, setAttribute() {}, style: { setProperty() {} },
  };
  settings.setupShortcutRecorder('shortcut', 'input');
  handlers.get('click')({ preventDefault() {}, stopPropagation() {} });
  assert.equal(events.get('keydown').size, 1);
  settings.close();
  assert.equal(events.get('keydown').size, 0);
  assert.equal(label.textContent, 'Alt+Q');
});

test('Saving a group label opacity of zero preserves the requested value', () => {
  const { context, values } = load();
  const settings = new context.SettingsClass();
  const fields = new Map();
  settings.modal = {
    querySelector(selector) {
      if (!fields.has(selector)) fields.set(selector, { value: selector === '#zs-tg-opacity' ? '0' : '7', checked: true });
      return fields.get(selector);
    }, setAttribute() {}, style: { setProperty() {} },
  };
  settings.save();
  assert.equal(values['zen.workspace.tabgroups.label_opacity'], 0);
});

test('Saving settings does not revive disabled app module listeners', () => {
  const { context, window } = load();
  let calls = 0;
  window.Zentral = { Apps: {
    applyHideUtilitySectionPref() { calls++; }, repositionGrid() { calls++; },
    updateAutohideState() { calls++; }, renderGrid() { calls++; },
  } };
  const settings = new context.SettingsClass();
  settings.modal = {
    querySelector: () => ({ checked: false, value: '7' }),
    setAttribute() {}, style: { setProperty() {} },
  };
  settings.save();
  assert.equal(calls, 0);
});
