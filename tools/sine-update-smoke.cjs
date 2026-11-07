const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const sineDir = process.argv[2];
if (!sineDir) throw new Error('Usage: node tools/sine-update-smoke.cjs <Sine chrome/JS directory> [--baseline]');
const root = path.resolve(__dirname, '..');
const managerSource = fs.readFileSync(path.join(sineDir, 'core/manager.sys.mjs'), 'utf8').replace(/\r\n/g, '\n');
const utilsSource = fs.readFileSync(path.join(sineDir, 'core/utils.sys.mjs'), 'utf8').replace(/\r\n/g, '\n');
const rawStart = utilsSource.indexOf('  rawURL(repo) {');
const rawEnd = utilsSource.indexOf('\n  },', rawStart);
assert.ok(rawStart >= 0 && rawEnd > rawStart, 'Sine rawURL implementation not found');
const rawMethod = utilsSource.slice(rawStart, rawEnd + 4);
const managerClass = managerSource.slice(managerSource.indexOf('class Manager {'), managerSource.lastIndexOf('export default new Manager();'));
const fork = 'https://github.com/TH0p/BZENITAL';
const original = 'https://github.com/Michele501st/Zentral-Sine';
const candidate = process.argv.includes('--baseline')
  ? JSON.parse(execFileSync('git', ['show', '9aac890d7b61a418c6a4d2966504a4325db00de7:theme.json'], { cwd: root, encoding: 'utf8' }))
  : JSON.parse(fs.readFileSync(path.join(root, 'theme.json'), 'utf8'));
const upstream = { id: 'zentral', name: 'Zentral', homepage: original, version: '1.1.0', description: 'Upstream' };
const requests = [];
const downloads = [];
let updatedAt = '2026-11-07T00:00:00Z';
const clone = value => JSON.parse(JSON.stringify(value));
const context = vm.createContext({
  ChromeUtils: { importESModule: () => ({ default: {} }) },
  ucAPI: {
    utils: { generateUUID: () => 'unused-test-id' },
    async fetch(url) {
      requests.push(url);
      if (url.startsWith('https://raw.githubusercontent.com/TH0p/BZENITAL/')) return clone(candidate);
      if (url.startsWith('https://raw.githubusercontent.com/Michele501st/Zentral-Sine/')) return clone(upstream);
      if (url.startsWith('https://api.github.com/repos/')) return { updated_at: updatedAt };
      throw new Error(`Unexpected Sine request: ${url}`);
    },
  },
});
vm.runInContext(`const utils = {${rawMethod}};\n${managerClass}\nthis.manager = new Manager();`, context);
const manager = context.manager;
manager.syncModData = async (repository, mods, metadata) => {
  downloads.push(repository);
  mods[metadata.id] = clone(metadata);
  return true;
};

(async () => {
  const installed = await manager.createThemeJSON(fork, {}, clone(candidate));
  const mods = { [installed.id]: installed };
  for (const nextDate of ['2026-11-08T00:00:00Z', '2026-11-09T00:00:00Z']) {
    updatedAt = nextDate;
    const result = await manager.processModUpdate(mods[installed.id], mods, null);
    assert.equal(result.changed, true);
    assert.equal(downloads.at(-1), fork, 'Sine must keep downloading updates from BZENITAL');
    assert.equal(mods[installed.id].homepage, fork);
  }
  assert.equal(requests.some(url => url.includes('/Michele501st/Zentral-Sine/')), false, 'The fork updater must never request upstream files');
  assert.notEqual(installed.id, upstream.id, 'BZENITAL must not overwrite the original Sine identity');
  const coexist = { [upstream.id]: upstream, [installed.id]: installed };
  assert.equal(Object.keys(coexist).length, 2);
  assert.equal(coexist.zentral.name, 'Zentral');
  assert.equal(mods[installed.id].version, candidate.version);
  console.log(JSON.stringify({ id: installed.id, version: candidate.version, updateSource: fork, consecutiveUpdates: downloads.length, upstreamRequests: 0, distinctOriginalIdentity: true }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
