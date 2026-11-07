const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const source = readFileSync(join(__dirname, '../JS/Zentral.uc.js'), 'utf8').replace(/\r\n/g, '\n');
const startMarker = 'submitReportBtn.addEventListener("click", async () => {';
const start = source.indexOf(startMarker) + startMarker.length;
const end = source.indexOf('\n        });\n      }', start);
const handler = source.slice(start, end);

function report({ endpoint = '', response, logger, fetchImpl } = {}) {
  const tabs = [];
  const requests = [];
  const titleInput = { value: 'Broken panel', style: {}, focus() {} };
  const descInput = { value: 'The panel does not open', style: {}, focus() {} };
  const button = { innerHTML: 'Submit', style: {}, disabled: false };
  const status = {
    style: {}, textContent: '', innerHTML: '', children: [],
    replaceChildren(...nodes) { this.children = nodes; },
    appendChild(node) { this.children.push(node); },
  };
  const context = vm.createContext({
    submitReportBtn: button, titleInput, descInput, statusEl: status,
    categoryInput: { value: 'bug' }, attachLogCheckbox: { checked: true },
    saveDiagnosticsPrefsImmediately() {},
    Core: { getPref: () => endpoint, log() {} }, Constants: { VERSION: '2.3', Diagnostics: { PREF_REPORT_ENDPOINT: 'endpoint' } },
    window: {
      ZentralLogger: logger,
      innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1,
      gBrowser: { addTab: url => tabs.push(url) },
      removeEventListener() {},
    },
    document: {
      documentElement: { getAttribute: () => 'true', removeAttribute() {} },
      getElementById: () => null,
      createElementNS: () => ({ style: {}, setAttribute(name, value) { this[name] = value; } }),
    },
    navigator: { userAgent: 'Zen test', platform: 'Windows' },
    Services: { scriptSecurityManager: { getSystemPrincipal: () => ({}) } },
    Cc: {}, Ci: {}, URL, AbortController, setTimeout, clearTimeout,
    console: { warn() {}, error() {} },
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (fetchImpl) return fetchImpl(url, init);
      return { ok: true, json: async () => response || { success: true, issueNumber: 7, issueUrl: 'https://github.com/TH0p/BZENITAL/issues/7' } };
    },
  });
  const settingsSource = source.slice(source.indexOf('  class ZentralSettings {'), source.search(/  (?:const|let) Apps = new ZentralApps\(\);/));
  vm.runInContext(`${settingsSource}\nthis.settings = new ZentralSettings();`, context);
  return { run: () => vm.runInContext(`(async function() {${handler}}).call(settings)`, context), settings: context.settings, tabs, requests, button, status, titleInput };
}

test('An unconfigured reporter opens a draft in the fork without sending logs to a worker', async () => {
  const env = report();
  await env.run();
  assert.equal(env.requests.length, 0);
  const url = new URL(env.tabs[0]);
  assert.equal(url.origin + url.pathname, 'https://github.com/TH0p/BZENITAL/issues/new');
  assert.match(url.searchParams.get('body'), /2\.3/);
});

test('Worker response URLs cannot inject markup into the privileged settings window', async () => {
  const env = report({ endpoint: 'https://reports.example.test/', response: { success: true, issueNumber: 7, issueUrl: 'javascript:alert(1)" onclick="evil()' } });
  await env.run();
  assert.equal(env.status.innerHTML, '');
  assert.equal(env.titleInput.value, 'Broken panel');
  assert.equal(env.tabs.length, 1);
});

test('A valid worker result creates a safe GitHub link and restores the submit button', async () => {
  const env = report({ endpoint: 'https://reports.example.test/' });
  await env.run();
  assert.equal(env.status.innerHTML, '');
  assert.equal(env.status.children[0].href, 'https://github.com/TH0p/BZENITAL/issues/7');
  assert.equal(env.titleInput.value, '');
  assert.equal(env.button.disabled, false);
});

test('Failing log generation restores the submit button and preserves the report', async () => {
  const env = report({ logger: { generateLogString() { throw new Error('snapshot failed'); } } });
  await assert.doesNotReject(env.run());
  assert.equal(env.button.disabled, false);
  assert.equal(env.button.innerHTML, 'Submit');
  assert.equal(env.titleInput.value, 'Broken panel');
});

test('An invalid worker endpoint falls back to a GitHub draft without making a request', async () => {
  const env = report({ endpoint: 'file:///C:/sensitive.txt' });
  await env.run();
  assert.equal(env.requests.length, 0);
  assert.equal(env.tabs.length, 1);
});

test('The old shared endpoint is blocked even without a trailing slash', async () => {
  const env = report({ endpoint: 'https://zentral-issue-reporter.michele-pierini.workers.dev' });
  await env.run();
  assert.equal(env.requests.length, 0);
  assert.equal(env.tabs.length, 1);
});

test('Unloading settings aborts a pending report without opening a fallback tab', async () => {
  let rejectFetch;
  const env = report({ endpoint: 'https://reports.example.test/', fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
    rejectFetch = reject;
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }) });
  const pending = env.run();
  env.settings.destroy();
  assert.equal(env.requests[0].init.signal.aborted, true);
  rejectFetch(new Error('worker offline'));
  await pending;
  assert.equal(env.tabs.length, 0);
  assert.equal(env.button.disabled, false);
});

test('An explicitly configured worker can return an issue in its configured repository', async () => {
  const env = report({ endpoint: 'https://reports.example.test/', response: { success: true, issueNumber: 7, issueUrl: 'https://github.com/another-owner/private-repo/issues/7' } });
  await env.run();
  assert.equal(env.tabs.length, 0);
  assert.equal(env.status.children[0].href, 'https://github.com/another-owner/private-repo/issues/7');
});
