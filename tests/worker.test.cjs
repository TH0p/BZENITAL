const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const workerPromise = import('data:text/javascript;base64,' + Buffer.from(
  readFileSync(join(__dirname, '../serverless/worker.js'), 'utf8')
).toString('base64')).then(module => module.default);
const valid = { title: ' Broken sidebar ', description: ' Steps to reproduce ', category: 'bug' };
const env = { GITHUB_TOKEN: 'test-only-token' };
const request = data => new Request('https://report.test/', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});

async function withGithub(run, respond) {
  const previous = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init, data: JSON.parse(init.body) });
    return respond ? respond(url, init) : Response.json({
      number: 42, html_url: 'https://github.com/TH0p/BZENITAL/issues/42',
    }, { status: 201 });
  };
  try { await run(await workerPromise, calls); } finally { global.fetch = previous; }
}

test('malformed JSON is a client error and never creates an issue', async () => {
  await withGithub(async (worker, calls) => {
    const response = await worker.fetch(new Request('https://report.test/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
    }), env);
    assert.equal(response.status, 400);
    assert.equal(calls.length, 0);
  });
});

test('rejects null, arrays, non-string fields, blank text and invalid categories', async () => {
  await withGithub(async (worker, calls) => {
    for (const data of [null, [], { ...valid, title: '  ' }, { ...valid, title: 1 },
      { ...valid, description: {} }, { ...valid, category: '__proto__' },
      { ...valid, logs: [] }, { ...valid, systemInfo: null },
      { ...valid, systemInfo: { platform: {} } }]) {
      const response = await worker.fetch(request(data), env);
      assert.equal(response.status, 400, JSON.stringify(data));
    }
    assert.equal(calls.length, 0);
  });
});

test('rejects unsupported media and oversized bodies before contacting GitHub', async () => {
  await withGithub(async (worker, calls) => {
    assert.equal((await worker.fetch(new Request('https://report.test/', {
      method: 'POST', body: JSON.stringify(valid),
    }), env)).status, 415);
    assert.equal((await worker.fetch(request({ ...valid, logs: 'x'.repeat(300000) }), env)).status, 413);
    assert.equal(calls.length, 0);
  });
});

test('refuses missing credentials and malformed repository configuration', async () => {
  await withGithub(async (worker, calls) => {
    assert.equal((await worker.fetch(request(valid), {})).status, 503);
    assert.equal((await worker.fetch(request(valid), { ...env, GITHUB_REPOSITORY: '../wrong/path' })).status, 503);
    assert.equal(calls.length, 0);
  });
});

test('uses this fork by default and accepts an explicitly configured repository', async () => {
  await withGithub(async (worker, calls) => {
    const response = await worker.fetch(request(valid), env);
    assert.equal(response.status, 200);
    assert.equal(calls[0].url, 'https://api.github.com/repos/TH0p/BZENITAL/issues');
    assert.equal(calls[0].data.title, '[BUG] Broken sidebar');
    assert.ok(calls[0].data.body.includes('Steps to reproduce'));
    await worker.fetch(request(valid), { ...env, GITHUB_REPOSITORY: 'owner/custom-repo' });
    assert.equal(calls[1].url, 'https://api.github.com/repos/owner/custom-repo/issues');
  });
});

test('bounds the complete issue body and preserves log head and recent tail', async () => {
  await withGithub(async (worker, calls) => {
    const response = await worker.fetch(request({ ...valid,
      description: 'd'.repeat(12000), logs: 'HEAD\n' + 'x'.repeat(100000) + '\nTAIL',
    }), env);
    assert.equal(response.status, 200);
    assert.ok(calls[0].data.body.length <= 65536);
    assert.ok(calls[0].data.body.includes('HEAD'));
    assert.ok(calls[0].data.body.includes('TAIL'));
    assert.equal((await worker.fetch(request({ ...valid, title: 'x'.repeat(300) }), env)).status, 400);
    assert.equal((await worker.fetch(request({ ...valid, description: 'x'.repeat(70000) }), env)).status, 400);
  });
});

test('upstream HTML or transport errors become safe gateway errors', async () => {
  await withGithub(async worker => {
    const response = await worker.fetch(request(valid), env);
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes('SECRET'));
  }, () => new Response('<h1>SECRET proxy error</h1>', { status: 502 }));
  await withGithub(async worker => {
    const response = await worker.fetch(request(valid), env);
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes('SECRET'));
  }, () => { throw new Error('SECRET internal details'); });
});

test('preflight and method rejection preserve CORS without external calls', async () => {
  await withGithub(async (worker, calls) => {
    for (const method of ['OPTIONS', 'GET']) {
      const response = await worker.fetch(new Request('https://report.test/', { method }), env);
      if (method === 'OPTIONS') assert.ok(response.ok);
      else assert.equal(response.status, 405);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    }
    assert.equal(calls.length, 0);
  });
});
