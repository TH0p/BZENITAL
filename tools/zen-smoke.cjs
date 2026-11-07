const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const binary = process.argv[2] || 'C:\\Program Files\\Zen Browser\\zen.exe';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bzenital-smoke-'));
let browser;
let socket;
let connection;
let contentServer;
const contentRequests = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

// Probe actual use of the standalone helper without changing its behavior.
const probeGeometry = `
  win.__bzenitalGeometryCalls = {};
  for (const [name, original] of Object.entries(win.ZentralPanelGeometry)) {
    if (typeof original !== 'function') continue;
    win.ZentralPanelGeometry[name] = function(...args) {
      win.__bzenitalGeometryCalls[name] = (win.__bzenitalGeometryCalls[name] || 0) + 1;
      return original.apply(this, args);
    };
  }
`;

async function connect(port) {
  const stream = net.createConnection({ host: '127.0.0.1', port });
  await new Promise((resolve, reject) => { stream.once('connect', resolve); stream.once('error', reject); });
  let buffer = Buffer.alloc(0);
  const replies = [];
  const waiters = [];
  stream.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const colon = buffer.indexOf(58);
      if (colon < 0) return;
      const length = Number(buffer.subarray(0, colon).toString());
      if (buffer.length < colon + 1 + length) return;
      const packet = JSON.parse(buffer.subarray(colon + 1, colon + 1 + length));
      buffer = buffer.subarray(colon + 1 + length);
      if (waiters.length) waiters.shift()(packet);
      else replies.push(packet);
    }
  });
  const receive = () => replies.length ? Promise.resolve(replies.shift()) : new Promise(resolve => waiters.push(resolve));
  const greeting = await receive();
  assert.equal(greeting.applicationType, 'gecko');
  let id = 0;
  return {
    stream,
    async command(name, params = {}) {
      const currentId = ++id;
      const body = JSON.stringify([0, currentId, name, params]);
      stream.write(`${Buffer.byteLength(body)}:${body}`);
      let timer;
      const reply = await Promise.race([
        receive(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), 25000); }),
      ]).finally(() => clearTimeout(timer));
      assert.equal(reply[1], currentId);
      if (reply[2]) throw new Error(JSON.stringify(reply[2]));
      return reply[3];
    },
  };
}

(async () => {
  contentServer = http.createServer((request, response) => {
    contentRequests.push({ path: request.url, userAgent: request.headers['user-agent'] || '' });
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><title>BZENITAL smoke app</title><h1>Disposable local test app</h1>');
  });
  await new Promise(resolve => contentServer.listen(0, '127.0.0.1', resolve));
  const appBaseUrl = `http://127.0.0.1:${contentServer.address().port}`;
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  fs.writeFileSync(path.join(profile, 'user.js'), [
    `user_pref("marionette.port", ${port});`,
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.homepage", "about:blank");',
    'user_pref("browser.startup.page", 0);',
    'user_pref("browser.aboutwelcome.enabled", false);',
    'user_pref("zen.welcome-screen.seen", true);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  ].join('\n'));
  browser = spawn(binary, ['--headless', '--no-remote', '--profile', profile, '--marionette', '--remote-allow-system-access', 'about:blank'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
  });
  let stderr = '';
  browser.stderr.on('data', data => { stderr += data.toString(); });
  browser.stdout.resume();
  browser.on('error', error => { stderr += error.message; });
  for (let attempt = 0; attempt < 50; attempt++) {
    try { connection = await connect(port); break; } catch (_) { await delay(200); }
  }
  if (!connection) throw new Error(`Could not connect to disposable Zen instance: ${stderr.slice(-1500)}`);
  socket = connection.stream;
  await connection.command('WebDriver:NewSession', { capabilities: { alwaysMatch: { acceptInsecureCerts: false } } });
  await connection.command('Marionette:SetContext', { value: 'chrome' });
  const execute = async script => {
    const response = await connection.command('WebDriver:ExecuteScript', { script, args: [], newSandbox: false, sandbox: 'system', scriptTimeout: 20000 });
    return response.value;
  };
  const prefix = 'const win = Services.wm.getMostRecentWindow("navigator:browser");';
  const loaded = await execute(`${prefix}
    win.__bzenitalErrors = [];
    win.addEventListener('error', e => win.__bzenitalErrors.push(e.message));
    const originalError = win.console.error;
    win.console.error = (...args) => { win.__bzenitalErrors.push(args.map(String).join(' ')); originalError.apply(win.console, args); };
    Services.io.getProtocolHandler('resource').QueryInterface(Ci.nsIResProtocolHandler).setSubstitution('bzenital-smoke', Services.io.newURI(${JSON.stringify(pathToFileURL(root + path.sep).href)}));
    Services.scriptloader.loadSubScript('resource://bzenital-smoke/JS/zentral_logger.uc.js', win);
    Services.scriptloader.loadSubScript('resource://bzenital-smoke/JS/zentral_panel_geometry.uc.js', win);
    ${probeGeometry}
    Services.scriptloader.loadSubScript('resource://bzenital-smoke/JS/Zentral.uc.js', win);
    const style = win.document.createElementNS('http://www.w3.org/1999/xhtml', 'style');
    style.textContent = ${JSON.stringify(fs.readFileSync(path.join(root, 'chrome.css'), 'utf8'))};
    win.document.documentElement.appendChild(style);
    return { version: Services.appinfo.version, initialized: !!win.Zentral, geometryLoaded: typeof win.ZentralPanelGeometry?.clampRect === 'function', grid: !!win.document.getElementById('zen-apps-sidebar-grid'), delayed: win.gBrowserInit?.delayedStartupFinished, errors: win.__bzenitalErrors };
  `);
  assert.equal(loaded.initialized, true);
  assert.equal(loaded.geometryLoaded, true);
  // The grid is inserted by the module's scheduled first reposition, not synchronously.
  for (let attempt = 0; attempt < 30 && !loaded.grid; attempt++) {
    await delay(50);
    loaded.grid = await execute(`${prefix} return !!win.document.getElementById('zen-apps-sidebar-grid');`);
  }
  assert.equal(loaded.grid, true, JSON.stringify(loaded));
  const typedPreference = await execute(`${prefix}
    const key = 'zen.workspace.apps.sidebar.apps_per_row';
    Services.prefs.getDefaultBranch('').setStringPref(key, '7');
    win.Zentral.Core.setPref(key, 8);
    return { value: win.Zentral.Core.getPref(key), type: Services.prefs.getPrefType(key) };
  `);
  assert.equal(String(typedPreference.value), '8', JSON.stringify(typedPreference));
  const settings = await execute(`${prefix}
    win.Zentral.Settings.open();
    const modal = win.document.getElementById('zentral-settings-modal');
    const answer = { modal: !!modal, open: modal?.getAttribute('data-open'), reportOptIn: modal?.querySelector('#zs-report-attach-log')?.checked };
    win.Zentral.Settings.close();
    return answer;
  `);
  assert.equal(settings.open, 'true');
  assert.equal(settings.reportOptIn, false);
  await execute(`${prefix} Services.prefs.setBoolPref('zen.workspace.apps.sidebar.enabled', false); return true;`);
  await delay(100);
  const disabled = await execute(`${prefix} return !win.document.getElementById('zen-apps-sidebar-grid');`);
  assert.equal(disabled, true);
  await execute(`${prefix} Services.prefs.setBoolPref('zen.workspace.apps.sidebar.enabled', true); return true;`);
  await delay(100);
  const enabled = await execute(`${prefix} return !!win.document.getElementById('zen-apps-sidebar-grid');`);
  assert.equal(enabled, true);
  await execute(`${prefix}
    win.Zentral.Core.setPref('zen.workspace.apps.sidebar.animation_speed', 100);
    win.Zentral.Core.setPref('zen.workspace.apps.sidebar.show_navbar', true);
    win.Zentral.Core.setPref('zen.workspace.apps.sidebar.apps', JSON.stringify([
      { id: 'bzenital-smoke-app', url: ${JSON.stringify(appBaseUrl + '/first')}, title: 'BZENITAL smoke app', width: 420 }
    ]));
    return true;
  `);
  await waitFor(() => execute(`${prefix} return !!win.document.getElementById('zen-app-btn-bzenital-smoke-app');`), 'saved app tile');
  const panel = await execute(`${prefix}
    const app = JSON.parse(win.Zentral.Core.getPref('zen.workspace.apps.sidebar.apps'))[0];
    win.Zentral.Apps.openPanel(app);
    const root = win.document.getElementById('zen-app-panel-root');
    return { open: root.hasAttribute('open'), navbar: win.document.getElementById('zen-app-panel-navbar').style.display,
      handles: root.querySelectorAll('.zen-app-float-handle').length,
      separateCloseBox: !!root.querySelector('#zen-app-panel-close-box .zen-app-close-btn') };
  `);
  assert.equal(panel.open, true);
  assert.equal(panel.navbar, 'flex');
  assert.equal(panel.handles, 8);
  assert.equal(panel.separateCloseBox, true);
  await waitFor(() => contentRequests.some(request => request.path === '/first'), 'local app page request');
  await waitFor(() => execute(`${prefix}
    return win.document.querySelector('#zen-app-panel-slider > browser')?.currentURI?.spec === ${JSON.stringify(appBaseUrl + '/first')};
  `), 'local app page navigation');
  await execute(`${prefix}
    win.document.querySelector('.zen-app-mobile-btn').click();
    win.Zentral.Apps.navZoomStep(1);
    const input = win.document.querySelector('.zen-app-nav-url-input');
    input.value = ${JSON.stringify(appBaseUrl + '/second')};
    input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  `);
  await waitFor(() => contentRequests.some(request => request.userAgent.includes('Mobile')), 'mobile User-Agent on the local app request');
  await waitFor(() => execute(`${prefix}
    return win.document.querySelector('#zen-app-panel-slider > browser')?.currentURI?.spec === ${JSON.stringify(appBaseUrl + '/second')};
  `), 'navigation toolbar URL submission');
  const navigation = await execute(`${prefix}
    const app = JSON.parse(win.Zentral.Core.getPref('zen.workspace.apps.sidebar.apps'))[0];
    return { mobile: app.mobile, mobileButton: win.document.querySelector('.zen-app-mobile-btn').getAttribute('data-active'),
      zoom: app.zoom, zoomLabel: win.document.querySelector('.zen-app-nav-zoom-label').textContent };
  `);
  assert.equal(navigation.mobile, true);
  assert.equal(navigation.mobileButton, 'true');
  assert.equal(navigation.zoom, 1.1);
  assert.equal(navigation.zoomLabel, '110%');
  const floating = await execute(`${prefix}
    const root = win.document.getElementById('zen-app-panel-root');
    const grabber = root.querySelector('.zen-app-grabber');
    const rect = grabber.getBoundingClientRect();
    const coords = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0, pointerId: 1, bubbles: true, cancelable: true };
    grabber.dispatchEvent(new win.PointerEvent('pointerdown', coords));
    win.dispatchEvent(new win.PointerEvent('pointerup', coords));
    return { floating: root.getAttribute('data-floating'), side: root.getAttribute('data-pill-side'),
      width: root.getBoundingClientRect().width, height: root.getBoundingClientRect().height };
  `);
  assert.equal(floating.floating, 'true');
  assert.ok(['left', 'right'].includes(floating.side));
  assert.ok(floating.width >= 320 && floating.height >= 360, JSON.stringify(floating));
  const resized = await execute(`${prefix}
    const root = win.document.getElementById('zen-app-panel-root');
    const handle = root.querySelector('.zen-app-float-handle[data-dir="se"]');
    const rect = root.getBoundingClientRect();
    const coords = { clientX: rect.right - 2, clientY: rect.bottom - 2, button: 0, pointerId: 2, bubbles: true, cancelable: true };
    handle.dispatchEvent(new win.PointerEvent('pointerdown', coords));
    win.dispatchEvent(new win.PointerEvent('pointermove', { ...coords, clientX: coords.clientX - 20 }));
    const during = { width: root.getBoundingClientRect().width, inline: root.style.width, computed: win.getComputedStyle(root).width,
      minWidth: win.getComputedStyle(root).minWidth, maxWidth: win.getComputedStyle(root).maxWidth };
    win.dispatchEvent(new win.PointerEvent('pointerup', { ...coords, clientX: coords.clientX - 20 }));
    return { width: root.getBoundingClientRect().width, during, shieldReleased: !win.document.getElementById('zen-app-panel-drag-shield').hasAttribute('data-active') };
  `);
  assert.ok(resized.width >= 320 && resized.width < floating.width, JSON.stringify({ floating, resized }));
  assert.equal(resized.shieldReleased, true);
  const snapPreview = await execute(`${prefix}
    const root = win.document.getElementById('zen-app-panel-root');
    const grabber = root.querySelector('.zen-app-grabber');
    const rect = grabber.getBoundingClientRect();
    const coords = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0, pointerId: 3, bubbles: true, cancelable: true };
    grabber.dispatchEvent(new win.PointerEvent('pointerdown', coords));
    win.dispatchEvent(new win.PointerEvent('pointermove', { ...coords, clientX: win.innerWidth - 2 }));
    const preview = win.document.getElementById('zen-app-panel-dock-ghost').getAttribute('data-active');
    win.dispatchEvent(new win.PointerEvent('pointerup', { ...coords, clientX: win.innerWidth - 2 }));
    return preview;
  `);
  assert.equal(snapPreview, 'true');
  await waitFor(() => execute(`${prefix} return !win.document.getElementById('zen-app-panel-root').hasAttribute('data-floating');`), 'floating panel re-docking');
  const docking = await execute(`${prefix}
    const root = win.document.getElementById('zen-app-panel-root');
    const answer = { side: root.getAttribute('data-panel-side'), geometryCalls: win.__bzenitalGeometryCalls,
      ghostReleased: !win.document.getElementById('zen-app-panel-dock-ghost').hasAttribute('data-active') };
    win.Zentral.Apps.closePanel();
    return answer;
  `);
  assert.equal(docking.side, 'right');
  assert.equal(docking.ghostReleased, true);
  for (const method of ['clampRect', 'getDockSlots', 'hitTestSnapZone', 'computeResize', 'pickPillSide']) {
    assert.ok(docking.geometryCalls[method] > 0, `Standalone geometry method was not used: ${method}`);
  }
  await waitFor(() => execute(`${prefix} return !win.document.getElementById('zen-app-panel-root').hasAttribute('open');`), 'panel close animation');
  await execute(`${prefix}
    Services.prefs.setStringPref('zen.workspace.apps.sidebar.placement', 'vertical-bar');
    Services.prefs.setBoolPref('zen.workspace.apps.sidebar.autohide', false);
    return true;
  `);
  await waitFor(() => execute(`${prefix}
    const bar = win.document.getElementById('zentral-apps-vertical-bar');
    return bar && win.getComputedStyle(bar).display !== 'none' && bar.getBoundingClientRect().height > 0;
  `), 'custom compact App Bar');
  const compactBar = await execute(`${prefix}
    const rect = win.document.getElementById('zentral-apps-vertical-bar').getBoundingClientRect();
    return { height: rect.height, centerY: rect.top + rect.height / 2, windowHeight: win.innerHeight };
  `);
  assert.ok(compactBar.height < compactBar.windowHeight / 2, JSON.stringify(compactBar));
  assert.ok(Math.abs(compactBar.centerY - compactBar.windowHeight / 2) < 80, JSON.stringify(compactBar));
  await execute(`${prefix} win.Zentral.Apps.openPanel(JSON.parse(win.Zentral.Core.getPref('zen.workspace.apps.sidebar.apps'))[0]); return true;`);
  await waitFor(() => execute(`${prefix}
    return win.document.documentElement.getAttribute('zentral-vb-expanded') === 'true' &&
      win.document.getElementById('zentral-apps-vertical-bar').getBoundingClientRect().height > ${compactBar.height + 80};
  `), 'custom App Bar expansion');
  await execute(`${prefix} win.Zentral.Apps.closePanel(); return true;`);
  await waitFor(() => execute(`${prefix}
    const bar = win.document.getElementById('zentral-apps-vertical-bar');
    // Moving the add button between grid and footer can change the natural height.
    const targetHeight = parseFloat(win.getComputedStyle(bar).getPropertyValue('--zentral-vb-compact-h'));
    const height = bar.getBoundingClientRect().height;
    return !win.document.documentElement.hasAttribute('zentral-vb-expanded') &&
      targetHeight > 0 && height < win.innerHeight / 2 && Math.abs(height - targetHeight) < 2;
  `), 'custom App Bar collapse');
  const groupCreated = await execute(`${prefix}
    const options = { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(), skipAnimation: true };
    const first = win.gBrowser.addTab('about:blank', options);
    const second = win.gBrowser.addTab('about:blank', options);
    const group = win.gBrowser.addTabGroup([first, second], { label: 'BZENITAL smoke', color: 'blue', insertBefore: first });
    win.__bzenitalGroup = { group, first, second };
    return { connected: group.isConnected, hasTabs: group.contains(first) && group.contains(second) };
  `);
  assert.equal(groupCreated.connected && groupCreated.hasTabs, true);
  await execute(`${prefix} Services.prefs.setBoolPref('zen.workspace.tabgroups.enabled', false); return true;`);
  await delay(100);
  const groupState = await execute(`${prefix}
    const { group, first, second } = win.__bzenitalGroup;
    return { connected: group.isConnected, first: group.contains(first), second: group.contains(second),
      firstParent: first.parentElement?.localName, secondParent: second.parentElement?.localName,
      appClosing: win.document.getElementById('zen-app-panel-root')?.hasAttribute('closing') };
  `);
  const groupPreserved = groupState.connected && groupState.first && groupState.second;
  assert.equal(groupPreserved, true, JSON.stringify(groupState));
  await execute(`${prefix} Services.prefs.setBoolPref('zen.workspace.tabgroups.enabled', true); return true;`);
  await delay(100);
  const groupReenabled = await execute(`${prefix}
    const { group, first, second } = win.__bzenitalGroup;
    return group.isConnected && group.contains(first) && group.contains(second) &&
      [...win.document.querySelectorAll('tab-group')].filter(node => node.id === group.id).length === 1;
  `);
  assert.equal(groupReenabled, true);
  const unloaded = await execute(`${prefix}
    win.Zentral.Destroy();
    win._zentralLoggerCleanup?.();
    return { unloaded: !win.Zentral && !win.document.getElementById('zen-apps-sidebar-grid') && !win.document.getElementById('zentral-settings-modal'), errors: win.__bzenitalErrors };
  `);
  assert.equal(unloaded.unloaded, true);
  assert.deepEqual(unloaded.errors, []);
  const reloaded = await execute(`${prefix}
    Services.scriptloader.loadSubScript('resource://bzenital-smoke/JS/zentral_logger.uc.js', win);
    Services.scriptloader.loadSubScript('resource://bzenital-smoke/JS/zentral_panel_geometry.uc.js', win);
    ${probeGeometry}
    Services.scriptloader.loadSubScript('resource://bzenital-smoke/JS/Zentral.uc.js', win);
    win.Zentral.Apps.repositionGrid();
    win.Zentral.Apps.openPanel(JSON.parse(win.Zentral.Core.getPref('zen.workspace.apps.sidebar.apps'))[0]);
    win.Zentral.Apps.detachPanel();
    const result = { initialized: !!win.Zentral, grids: win.document.querySelectorAll('#zen-apps-sidebar-grid').length, geometryUsed: win.__bzenitalGeometryCalls.clampRect > 0, groupPreserved: win.__bzenitalGroup.group.isConnected, errors: win.__bzenitalErrors };
    win.Zentral.Destroy();
    return result;
  `);
  assert.equal(reloaded.initialized, true);
  assert.equal(reloaded.grids, 1);
  assert.equal(reloaded.geometryUsed, true);
  assert.equal(reloaded.groupPreserved, true);
  assert.deepEqual(reloaded.errors, []);
  console.log(JSON.stringify({ browser: loaded.version, startup: loaded, typedPreference, settings, disabled, enabled, panel, navigation, mobileUserAgentObserved: true, floating, resized, docking, compactBar, groupCreated, groupPreserved, groupReenabled, cleanup: unloaded, reloaded }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try { if (connection) await connection.command('Marionette:Quit', { flags: ['eForceQuit'] }); } catch (_) {}
  socket?.destroy();
  if (browser && browser.exitCode === null) {
    await Promise.race([new Promise(resolve => browser.once('exit', resolve)), delay(3000)]);
    if (browser.exitCode === null) browser.kill();
  }
  if (contentServer) await new Promise(resolve => contentServer.close(resolve));
  // Only remove the new disposable profile created by this process.
  const target = path.resolve(profile);
  if (path.dirname(target) === path.resolve(os.tmpdir()) && path.basename(target).startsWith('bzenital-smoke-')) {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
