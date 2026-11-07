const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../JS/Zentral.uc.js'), 'utf8').replace(/\r\n/g, '\n');
const classSource = source.slice(source.indexOf('  class ZentralTabGroups {'), source.indexOf('  /* ============================================================================\n   * 5.0 SETTINGS MODULE', source.indexOf('  class ZentralTabGroups {')));

class Surface {
  constructor() { this.listeners = new Map(); this.attrs = new Map(); this.children = []; this.isConnected = true; this.style = { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; } }; }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  fire(type, data = {}) { for (const fn of [...(this.listeners.get(type) || [])]) fn({ type, target: this, ...data }); }
  setAttribute(key, value) { this.attrs.set(key, String(value)); }
  getAttribute(key) { return this.attrs.get(key) || ''; }
  hasAttribute(key) { return this.attrs.has(key); }
  removeAttribute(key) { this.attrs.delete(key); }
  replaceChildren(...children) { this.children = []; for (const child of children) this.appendChild(child); }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  closest() { return null; }
  remove() { this.isConnected = false; }
}

class Element extends Surface {
  constructor(tagName = 'div') { super(); this.tagName = tagName; this.nodeType = 1; this.tokens = new Set(); this.classList = { contains: token => this.tokens.has(token), add: token => this.tokens.add(token), remove: token => this.tokens.delete(token) }; }
  set className(value) { this.tokens = new Set(value.split(/\s+/).filter(Boolean)); }
  get className() { return [...this.tokens].join(' '); }
  get parentElement() { return this.parentNode || null; }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, before) { if (child.parentNode) child.parentNode.children.splice(child.parentNode.children.indexOf(child), 1); const index = before ? this.children.indexOf(before) : -1; this.children.splice(index < 0 ? this.children.length : index, 0, child); child.parentNode = this; return child; }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; super.remove(); }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (selector.split(',').some(part => node.matches?.(part.trim()))) return node; return null; }
  matches(selector) { return selector === '*' || (selector.startsWith('.') ? this.classList.contains(selector.slice(1)) : this.tagName.toLowerCase() === selector); }
  querySelectorAll(selector) { const matches = []; for (const child of this.children) { if (selector.split(',').some(part => child.matches(part.trim()))) matches.push(child); matches.push(...child.querySelectorAll(selector)); } return matches; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  contains(child) { return child === this || this.querySelectorAll('*').includes(child); }
}

function harness() {
  const window = new Surface();
  const document = new Surface();
  window.document = document;
  document.documentElement = new Surface();
  document.createElement = tag => new Element(tag);
  const tabContainer = new Surface();
  const menu = new Surface();
  const tooltip = new Surface();
  const elements = new Map([['tabbrowser-tabs', tabContainer], ['tabContextMenu', menu], ['zentral-tabgroup-tooltip', tooltip]]);
  document.getElementById = id => elements.get(id) || null;
  const observers = [];
  class MutationObserver { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } }
  const prefs = new Map([['enabled', true], ['state', '{}'], ['colors', '{}'], ['thumbnails', true]]);
  const timers = new Map(); let timerId = 0;
  const setTimeout = fn => { timers.set(++timerId, fn); return timerId; };
  const clearTimeout = id => timers.delete(id);
  window.setTimeout = setTimeout;
  window.requestAnimationFrame = setTimeout;
  window.cancelAnimationFrame = clearTimeout;
  const gBrowser = { tabContainer, tabs: [], addTab() {} };
  window.gBrowser = gBrowser;
  const Services = { prefs: { addObserver() {}, removeObserver() {} }, obs: { addObserver() {}, removeObserver() {} } };
  const deletedValues = [];
  const SessionStore = { getCustomTabValue() { return ''; }, setCustomTabValue() {}, deleteCustomTabValue(tab, key) { deletedValues.push([tab, key]); } };
  const Constants = { TabGroups: { PREF_ENABLED: 'enabled', PREF_STATE: 'state', PREF_COLORS: 'colors', PREF_COLLAPSE_ON_LAUNCH: 'collapse', PREF_THUMBNAILS: 'thumbnails' } };
  const errors = [];
  const Core = { getPref: key => prefs.get(key), setPref: (key, value) => prefs.set(key, value), getNativePref: () => true, isEffectiveDarkMode: () => false, updateEffectiveTheme() {}, log() {}, emit() {}, error(...args) { errors.push(args); } };
  const context = vm.createContext({ window, document, MutationObserver, Node: { ELEMENT_NODE: 1 }, Core, Constants, Services, SessionStore, gBrowser, setTimeout, clearTimeout, console: { error(...args) { errors.push(args); }, warn(...args) { errors.push(args); } } });
  vm.runInContext(`${classSource}\nthis.Groups = ZentralTabGroups;`, context);
  const groups = new context.Groups();
  function init() {
    for (const method of ['clearStoredColorData', 'loadSavedColors', 'reconstructSavedGroups', 'injectStyles', 'setupObserver', 'setupPopupSuppression', 'addFolderContextMenuItems', 'removeBuiltinTabGroupMenu', 'enhanceTabContextMenu', 'initTabDragSelectionGuard', 'processExistingGroups', 'setupTabOpenHandler', 'hookAddTab']) groups[method] = () => {};
    groups.init();
  }
  return { groups, window, document, tabContainer, menu, prefs, timers, observers, gBrowser, Services, Core, elements, init, errors, deletedValues };
}

test('sanitization preserves an untitled parent containing a populated child', () => {
  const { groups } = harness();
  const result = groups.sanitizeState({ groups: { parent: { label: '', id: 'parent' }, child: { label: 'Child', parentId: 'parent' } }, tabMapping: { child: [{ zenTabId: 'tab-1' }] } });
  assert.ok(result.groups.parent);
  assert.equal(result.groups.child.parentId, 'parent');
});

test('legacy group metadata without a tab-mapping section remains recoverable', () => {
  const { groups } = harness();
  const result = groups.sanitizeState({ g: { id: 'g', label: 'Work' } });
  assert.equal(result.groups.g?.label, 'Work');
});

test('moving a connected group never deletes its saved color or hierarchy', () => {
  const { groups, prefs, observers } = harness();
  const saved = '{"groups":{"g":{"id":"g","label":"Work"}},"tabMapping":{"g":[{"zenTabId":"t"}]}}';
  prefs.set('state', saved); prefs.set('colors', '{"g":"#123456"}');
  groups.setupObserver();
  const node = new Surface(); node.id = 'g'; node.tagName = 'tab-group'; node.nodeType = 1;
  observers[0].callback([{ type: 'childList', addedNodes: [], removedNodes: [node] }]);
  assert.equal(prefs.get('state'), saved);
  assert.equal(prefs.get('colors'), '{"g":"#123456"}');
});

test('saving during session restoration preserves recovery state and tab metadata', () => {
  const h = harness(); h.init();
  const saved = '{"groups":{"g":{"id":"g","label":"Work"}},"tabMapping":{"g":[{"zenTabId":"t"}]}}';
  h.prefs.set('state', saved);
  const tab = new Surface(); tab.setAttribute('data-zentral-group-id', 'g'); h.gBrowser.tabs = [tab];
  h.groups.saveTabGroupState();
  assert.equal(h.prefs.get('state'), saved);
  assert.equal(tab.getAttribute('data-zentral-group-id'), 'g');
  assert.equal(h.deletedValues.length, 0);
});

test('unloading during session restoration preserves saved groups', () => {
  const h = harness(); h.init();
  const saved = '{"groups":{"g":{"id":"g","label":"Work"}},"tabMapping":{"g":[{"zenTabId":"t"}]}}';
  h.prefs.set('state', saved);
  h.groups.destroy();
  assert.equal(h.prefs.get('state'), saved);
});

test('destroy removes document group listeners and both submenu listeners', () => {
  const h = harness();
  const enhance = h.groups.enhanceTabContextMenu.bind(h.groups);
  h.init(); enhance();
  h.groups.destroy();
  for (const type of ['TabGroupCreate', 'tabgroupcreated', 'TabGroupCreateByUser', 'TabGroupUpdate']) assert.equal(h.document.listeners.get(type)?.size || 0, 0, type);
  for (const type of ['popupshowing', 'popupshown']) assert.equal(h.window.listeners.get(type)?.size || 0, 0, type);
  assert.equal(h.menu._zentralEnhanced, undefined);
});

test('destroy preserves native groups, nesting, and member tabs', () => {
  const h = harness(); h.init();
  const group = new Surface(); group.id = 'g'; group.tagName = 'tab-group';
  const tab = new Surface(); tab.group = group;
  group.querySelectorAll = selector => selector.includes('tab,') ? [tab] : [];
  h.document.querySelectorAll = selector => selector.startsWith('tab-group') ? [group] : [];
  h.groups.destroy();
  assert.equal(group.isConnected, true);
  assert.equal(tab.group, group);
});

test('dragging restores existing selection property descriptors after a native exception', () => {
  const h = harness();
  const active = new Surface(); const dragged = new Surface();
  Object.defineProperty(h.gBrowser, 'selectedTab', { value: active, writable: true, configurable: true, enumerable: true });
  Object.defineProperty(h.gBrowser, 'selectedElements', { value: [active], writable: true, configurable: true, enumerable: true });
  Object.defineProperty(h.tabContainer, 'selectedItem', { value: active, writable: true, configurable: true, enumerable: true });
  const original = ['selectedTab', 'selectedElements'].map(key => Object.getOwnPropertyDescriptor(h.gBrowser, key));
  const itemDescriptor = Object.getOwnPropertyDescriptor(h.tabContainer, 'selectedItem');
  const failure = new Error('Native drag failed');
  h.tabContainer.tabDragAndDrop = { startTabDrag() { throw failure; } };
  h.groups.initTabDragSelectionGuard();
  assert.throws(() => h.tabContainer.tabDragAndDrop.startTabDrag({}, dragged), failure);
  assert.deepEqual(Object.getOwnPropertyDescriptor(h.gBrowser, 'selectedTab'), original[0]);
  assert.deepEqual(Object.getOwnPropertyDescriptor(h.gBrowser, 'selectedElements'), original[1]);
  assert.deepEqual(Object.getOwnPropertyDescriptor(h.tabContainer, 'selectedItem'), itemDescriptor);
});

test('click guard restores selection descriptors when focus leaves the window', () => {
  const h = harness(); const active = new Surface(); const tab = new Surface();
  tab.closest = selector => selector.includes('tab,') ? tab : null;
  h.gBrowser.selectedTab = active; h.tabContainer.selectedItem = active;
  const expected = Object.getOwnPropertyDescriptor(h.gBrowser, 'selectedTab');
  h.groups.initTabDragSelectionGuard();
  h.tabContainer.fire('mousedown', { button: 0, target: tab, clientX: 1, clientY: 2 });
  h.window.fire('blur');
  assert.deepEqual(Object.getOwnPropertyDescriptor(h.gBrowser, 'selectedTab'), expected);
  assert.equal(h.tabContainer.selectedItem, active);
});

test('hot unload cancels pending folder-menu and saved-color work', () => {
  const h = harness(); let workAfterUnload = 0;
  const getElement = h.document.getElementById;
  h.document.getElementById = id => { if (id === 'zenFolderActions' || id === 'g') workAfterUnload++; return getElement(id); };
  h.prefs.set('colors', '{"g":"#123456"}');
  h.groups.addFolderContextMenuItems(); h.groups.loadSavedColors();
  h.groups.destroy();
  for (const callback of [...h.timers.values()]) callback();
  assert.equal(workAfterUnload, 0);
});

test('an awaited favicon result cannot recolor a group after unload', async () => {
  const h = harness(); const group = new Surface(); let writes = 0; let finish;
  group.style.setProperty = () => writes++;
  h.groups.getDirectTabs = () => [new Surface()];
  h.groups.extractTabFaviconColor = () => new Promise(resolve => { finish = resolve; });
  const work = h.groups.applyAverageGroupColor(group, true);
  h.groups.destroy(); finish([100, 120, 140]); await work;
  assert.equal(writes, 0);
});

test('automatic favicon color never overwrites a color chosen while the image loads', async () => {
  const h = harness(); const group = new Surface(); const colors = new Map(); let finish;
  group.style.getPropertyValue = key => colors.get(key) || '';
  group.style.setProperty = (key, value) => colors.set(key, value);
  h.groups.getDirectTabs = () => [new Surface()];
  h.groups.extractTabFaviconColor = () => new Promise(resolve => { finish = resolve; });
  const work = h.groups.applyAverageGroupColor(group);
  colors.set('--zentral-custom-color', '#ff0000');
  finish([100, 120, 140]); await work;
  assert.equal(colors.get('--zentral-custom-color'), '#ff0000');
});

test('group style enforcement drains its own mutations instead of scheduling an endless loop', () => {
  const h = harness();
  const group = new Element('tab-group'); group.id = 'g'; group.label = 'Work';
  const label = new Element(); label.className = 'tab-group-label-container';
  const text = new Element('label'); text.className = 'tab-group-label'; label.appendChild(text); group.appendChild(label);
  const tabs = new Element(); tabs.className = 'tab-group-container'; group.appendChild(tabs);
  h.groups.updateCollapsedLabel = () => {}; h.groups.addContextMenu = () => {};
  h.groups.checkAndApplyFirstTimeGroupColor = () => {}; h.groups.updateGroupSubGroupsBadge = () => {};
  h.groups.processGroup(group);
  const styleObserver = h.observers[0]; let selfMutationsDrained = false;
  styleObserver.takeRecords = () => { selfMutationsDrained = true; return []; };
  styleObserver.callback();
  assert.equal(selfMutationsDrained, true);
});

test('unloading removes group decorations and listeners while preserving native contents', () => {
  const h = harness();
  const group = new Element('tab-group'); group.id = 'g'; group.label = 'Work';
  const label = new Element(); label.className = 'tab-group-label-container';
  const text = new Element('label'); text.className = 'tab-group-label'; label.appendChild(text); group.appendChild(label);
  const tabs = new Element(); tabs.className = 'tab-group-container'; const tab = new Element('tab'); tabs.appendChild(tab); group.appendChild(tabs);
  h.groups.updateCollapsedLabel = () => {}; h.groups.addContextMenu = () => {};
  h.groups.checkAndApplyFirstTimeGroupColor = () => {}; h.groups.updateGroupSubGroupsBadge = () => {};
  h.groups.processGroup(group); h.groups.destroy();
  assert.equal(group.classList.contains('zentral-standard'), false);
  assert.equal(group.hasAttribute('zentral-group'), false);
  assert.equal(group.querySelector('.zentral-tab-title-wrapper'), null);
  assert.equal(label.listeners.get('click')?.size || 0, 0);
  assert.equal(group.contains(tab), true);
  assert.equal(h.observers[0].disconnected, true);
});

test('collapse-on-launch is not reapplied after session restoration', () => {
  const h = harness(); const group = new Element('tab-group'); group.id = 'g';
  h.prefs.set('state', '{"groups":{"g":{"collapsed":false}}}'); h.prefs.set('collapse', true);
  h.document.querySelectorAll = () => [group];
  h.init();
  [...h.timers.values()][0]();
  group.removeAttribute('collapsed'); group.collapsed = false;
  h.groups.loadTabGroupState();
  assert.equal(group.collapsed, false);
});

test('explicit expanded recovery metadata overrides older collapsed state', () => {
  const h = harness(); const group = new Element('tab-group'); group.id = 'g'; group.label = 'Work';
  const label = new Element(); label.className = 'tab-group-label-container';
  const text = new Element('label'); text.className = 'tab-group-label'; label.appendChild(text); group.appendChild(label);
  const tabs = new Element(); tabs.className = 'tab-group-container'; group.appendChild(tabs);
  const tab = new Element('tab'); tab.setAttribute('data-zentral-group-id', 'g'); tab.setAttribute('data-zentral-group-collapsed', 'false'); tabs.appendChild(tab);
  h.tabContainer.appendChild = child => { child.parentNode = h.tabContainer; };
  h.tabContainer.appendChild(group);
  h.gBrowser.tabs = [tab];
  h.document.querySelectorAll = selector => selector.startsWith('tab-group') ? [group] : [tab];
  const getElement = h.document.getElementById; h.document.getElementById = id => id === 'g' ? group : getElement(id);
  h.prefs.set('state', '{"groups":{"g":{"id":"g","label":"Work","collapsed":true}},"tabMapping":{"g":[{"zenTabId":"t"}]}}');
  h.groups.processGroup = () => {};
  h.groups.reconstructSavedGroups();
  assert.deepEqual(h.errors, []);
  assert.equal(group.collapsed, false);
  assert.equal(h.errors.length, 0);
});

test('suppressing native group popups preserves their DOM for use after unload', () => {
  const h = harness(); const editor = new Element('panel'); editor.id = 'tab-group-editor'; let hidden = 0;
  editor.hidePopup = () => hidden++;
  h.document.querySelectorAll = selector => selector === '#tab-group-editor' ? [editor] : [];
  h.groups.setupPopupSuppression();
  h.window.fire('popupshowing', { target: editor, preventDefault() {}, stopPropagation() {} });
  assert.equal(editor.isConnected, true);
  assert.ok(hidden > 0);
});

function groupedTab(groupId, tabId, workspace = 'shared-workspace') {
  const group = new Element('tab-group'); group.id = groupId; group.label = groupId; group.setAttribute('zen-workspace-id', workspace);
  const container = new Element(); container.className = 'tab-group-container'; group.appendChild(container);
  const tab = new Element('tab'); tab.id = tabId; tab.setAttribute('zen-tab-id', tabId); container.appendChild(tab);
  return { group, container, tab };
}

function enumerateWindows(...windows) {
  let index = 0;
  return { hasMoreElements: () => index < windows.length, getNext: () => windows[index++] };
}

test('saving one window preserves another live window hierarchy and its tab mapping', () => {
  const a = harness(); const b = harness();
  a.window.gZenWorkspaces = b.window.gZenWorkspaces = { activeWorkspace: 'shared-workspace' };
  const local = groupedTab('local', 'local-tab');
  const remote = groupedTab('remote-child', 'remote-tab');
  const parent = new Element('tab-group'); parent.id = 'remote-parent'; parent.label = 'Parent'; parent.setAttribute('zen-workspace-id', 'shared-workspace'); parent.appendChild(remote.group);
  a.document.querySelectorAll = selector => selector.startsWith('tab-group') ? [local.group] : [local.tab];
  b.document.querySelectorAll = selector => selector.startsWith('tab-group') ? [parent, remote.group] : [remote.tab];
  a.gBrowser.tabs = [local.tab]; b.gBrowser.tabs = [remote.tab];
  for (const h of [a, b]) h.Services.wm = { getEnumerator: () => enumerateWindows(a.window, b.window) };
  a.prefs.set('state', JSON.stringify({ groups: { 'remote-parent': { id: 'remote-parent', label: 'Parent', workspaceId: 'shared-workspace' }, 'remote-child': { id: 'remote-child', label: 'Child', parentId: 'remote-parent', workspaceId: 'shared-workspace' } }, tabMapping: { 'remote-parent': [], 'remote-child': [{ zenTabId: 'remote-tab', url: 'https://example.test/remote' }] } }));
  a.groups.saveTabGroupState();
  let saved = JSON.parse(a.prefs.get('state'));
  assert.equal(saved.groups['remote-child']?.parentId, 'remote-parent');
  assert.equal(saved.groups['remote-parent']?.label, 'Parent');
  assert.deepEqual(saved.tabMapping['remote-child'], [{ zenTabId: 'remote-tab', url: 'https://example.test/remote' }]);
  b.prefs.set('state', a.prefs.get('state'));
  b.groups.saveTabGroupState();
  saved = JSON.parse(b.prefs.get('state'));
  assert.equal(saved.groups.local?.label, 'local');
  assert.deepEqual(saved.tabMapping.local, [{ zenTabId: 'local-tab', url: '' }]);
  assert.equal(saved.groups['remote-child'].parentId, 'remote-parent');
});

test('a confirmed deleted group is pruned when all browser windows can be inspected', () => {
  const h = harness(); h.window.gZenWorkspaces = { activeWorkspace: 'shared-workspace' };
  h.Services.wm = { getEnumerator: () => enumerateWindows(h.window) };
  h.prefs.set('state', '{"groups":{"deleted":{"id":"deleted","workspaceId":"shared-workspace"}},"tabMapping":{"deleted":[{"zenTabId":"old-tab"}]}}');
  h.groups.saveTabGroupState();
  assert.deepEqual(JSON.parse(h.prefs.get('state')), { groups: {}, tabMapping: {} });
});

test('unavailable window enumeration conservatively preserves recovery metadata', () => {
  const h = harness(); const saved = '{"groups":{"g":{"id":"g"}},"tabMapping":{"g":[{"zenTabId":"t"}]}}';
  h.prefs.set('state', saved);
  h.groups.saveTabGroupState();
  assert.deepEqual(JSON.parse(h.prefs.get('state')), JSON.parse(saved));
});

test('failed window enumeration conservatively preserves recovery metadata', () => {
  const h = harness(); const saved = '{"groups":{"g":{"id":"g"}},"tabMapping":{"g":[{"zenTabId":"t"}]}}';
  h.prefs.set('state', saved); h.Services.wm = { getEnumerator() { throw new Error('Window service unavailable'); } };
  h.groups.saveTabGroupState();
  assert.deepEqual(JSON.parse(h.prefs.get('state')), JSON.parse(saved));
});

test('the removal observer preserves metadata when a group has moved to another window', () => {
  const h = harness(); const remoteGroup = new Element('tab-group'); remoteGroup.id = 'g';
  const otherWindow = { document: { querySelectorAll: () => [remoteGroup] } };
  h.Services.wm = { getEnumerator: () => enumerateWindows(h.window, otherWindow) };
  const state = '{"groups":{"g":{"id":"g","label":"Work"}},"tabMapping":{"g":[{"zenTabId":"t"}]}}';
  h.prefs.set('state', state); h.prefs.set('colors', '{"g":"#123456"}');
  h.groups.setupObserver();
  const oldGroup = new Element('tab-group'); oldGroup.id = 'g'; oldGroup.isConnected = false;
  h.observers[0].callback([{ type: 'childList', addedNodes: [], removedNodes: [oldGroup] }]);
  assert.equal(h.prefs.get('state'), state);
  assert.equal(h.prefs.get('colors'), '{"g":"#123456"}');
});

test('unload restores native label context and an empty boolean hidden attribute', () => {
  const h = harness(); const { group } = groupedTab('g', 't');
  const label = new Element(); label.className = 'tab-group-label-container'; label.setAttribute('context', 'native-group-menu');
  const text = new Element('label'); text.className = 'tab-group-label'; label.appendChild(text);
  const icon = new Element(); icon.className = 'tab-group-icon';
  const marker = new Element('image'); marker.setAttribute('hidden', ''); icon.appendChild(marker); label.appendChild(icon); group.appendChild(label);
  for (const method of ['updateCollapsedLabel', 'addContextMenu', 'checkAndApplyFirstTimeGroupColor', 'updateGroupSubGroupsBadge']) h.groups[method] = () => {};
  h.groups.processGroup(group); h.groups.destroy();
  assert.equal(label.getAttribute('context'), 'native-group-menu');
  assert.equal(marker.hasAttribute('hidden'), true);
  assert.equal(marker.getAttribute('hidden'), '');
});

test('the tooltip refreshes its effective theme before opening and cancels pending hover work on unload', () => {
  const h = harness(); const { group } = groupedTab('g', 't');
  const label = new Element(); label.className = 'tab-group-label-container';
  const text = new Element('label'); text.className = 'tab-group-label'; label.appendChild(text); group.appendChild(label);
  const tooltip = h.elements.get('zentral-tabgroup-tooltip');
  const container = new Element(); h.elements.set('zentral-tabgroup-tooltip-container', container);
  let theme = 'dark'; let opened = 0;
  h.Core.updateEffectiveTheme = () => tooltip.setAttribute('zentral-effective-theme', theme);
  tooltip.openPopup = () => opened++;
  for (const method of ['updateCollapsedLabel', 'addContextMenu', 'checkAndApplyFirstTimeGroupColor', 'updateGroupSubGroupsBadge']) h.groups[method] = () => {};
  h.groups.getDirectTabs = () => [];
  h.groups.processGroup(group);
  label.fire('mouseenter');
  assert.equal(tooltip.getAttribute('zentral-effective-theme'), 'dark');
  theme = 'light';
  for (const [id, callback] of [...h.timers]) { h.timers.delete(id); callback(); }
  assert.equal(tooltip.getAttribute('zentral-effective-theme'), 'light');
  assert.equal(opened, 1);
  label.fire('mouseenter'); h.groups.destroy(); theme = 'dark';
  for (const [id, callback] of [...h.timers]) { h.timers.delete(id); callback(); }
  assert.equal(tooltip.getAttribute('zentral-effective-theme'), 'light');
  assert.equal(opened, 1);
});

test('a hidden app retaining focus does not isolate newly opened browser tabs', () => {
  const h = harness();
  h.window.Zentral = { Apps: { isPanelOpen: () => false } };
  h.document.activeElement = { closest: () => ({ id: 'zen-app-panel-root' }) };
  let moves = 0;
  h.gBrowser.moveTabToEnd = () => moves++;
  h.gBrowser.addTab = () => new Element('tab');
  h.groups.hookAddTab();
  const tab = h.gBrowser.addTab('about:blank');
  assert.equal(moves, 0);
  assert.equal(tab._zentralForceUngroup, undefined);
});

test('a panel closing animation does not isolate newly opened browser tabs', () => {
  const h = harness();
  h.window.Zentral = { Apps: { isPanelOpen: () => false } };
  const panel = new Element(); panel.setAttribute('open', 'true'); panel.setAttribute('closing', 'true');
  h.elements.set('zen-app-panel-root', panel);
  let moves = 0;
  h.gBrowser.moveTabToEnd = () => moves++;
  h.gBrowser.addTab = () => new Element('tab');
  h.groups.hookAddTab();
  h.gBrowser.addTab('about:blank');
  assert.equal(moves, 0);
});

for (const entry of ['hook', 'TabOpen']) {
  test(`${entry} isolation never undoes a newly assigned native tab group`, () => {
    const h = harness();
    h.window.Zentral = { Apps: { isPanelOpen: () => true } };
    const original = new Element('tab-group'); original.id = 'original';
    const explicit = new Element('tab-group'); explicit.id = 'explicit';
    const outside = new Element('tabs');
    const tab = new Element('tab'); original.appendChild(tab);
    let moves = 0;
    h.gBrowser.moveTabToEnd = node => { moves++; outside.appendChild(node); };
    if (entry === 'hook') {
      h.gBrowser.addTab = () => tab;
      h.groups.hookAddTab(); h.gBrowser.addTab('about:blank');
    } else {
      h.groups.setupTabOpenHandler(); h.tabContainer.fire('TabOpen', { target: tab });
    }
    assert.equal(moves, 1);
    explicit.appendChild(tab); tab.setAttribute('data-zentral-group-id', 'explicit');
    for (const [id, callback] of [...h.timers]) { h.timers.delete(id); callback(); }
    assert.equal(tab.parentElement, explicit);
    assert.equal(tab.getAttribute('data-zentral-group-id'), 'explicit');
    assert.equal(moves, 1);
  });
}
