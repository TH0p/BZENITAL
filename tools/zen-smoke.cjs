const assert = require('node:assert/strict');
const fs = require('node:fs');
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
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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
    Services.scriptloader.loadSubScript('resource://bzenital-smoke/JS/Zentral.uc.js', win);
    const style = win.document.createElementNS('http://www.w3.org/1999/xhtml', 'style');
    style.textContent = ${JSON.stringify(fs.readFileSync(path.join(root, 'chrome.css'), 'utf8'))};
    win.document.documentElement.appendChild(style);
    return { version: Services.appinfo.version, initialized: !!win.Zentral, grid: !!win.document.getElementById('zen-apps-sidebar-grid'), delayed: win.gBrowserInit?.delayedStartupFinished, errors: win.__bzenitalErrors };
  `);
  assert.equal(loaded.initialized, true);
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
  const groupPreserved = await execute(`${prefix}
    const { group, first, second } = win.__bzenitalGroup;
    return group.isConnected && group.contains(first) && group.contains(second);
  `);
  assert.equal(groupPreserved, true);
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
    Services.scriptloader.loadSubScript('resource://bzenital-smoke/JS/Zentral.uc.js', win);
    win.Zentral.Apps.repositionGrid();
    const result = { initialized: !!win.Zentral, grids: win.document.querySelectorAll('#zen-apps-sidebar-grid').length, groupPreserved: win.__bzenitalGroup.group.isConnected, errors: win.__bzenitalErrors };
    win.Zentral.Destroy();
    return result;
  `);
  assert.equal(reloaded.initialized, true);
  assert.equal(reloaded.grids, 1);
  assert.equal(reloaded.groupPreserved, true);
  assert.deepEqual(reloaded.errors, []);
  console.log(JSON.stringify({ browser: loaded.version, startup: loaded, typedPreference, settings, disabled, enabled, groupCreated, groupPreserved, groupReenabled, cleanup: unloaded, reloaded }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try { if (connection) await connection.command('Marionette:Quit', { flags: ['eForceQuit'] }); } catch (_) {}
  socket?.destroy();
  if (browser && browser.exitCode === null) {
    await Promise.race([new Promise(resolve => browser.once('exit', resolve)), delay(3000)]);
    if (browser.exitCode === null) browser.kill();
  }
  // Only remove the new disposable profile created by this process.
  const target = path.resolve(profile);
  if (path.dirname(target) === path.resolve(os.tmpdir()) && path.basename(target).startsWith('bzenital-smoke-')) {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
