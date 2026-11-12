import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createPreviewServer, validateIsaacBaseUrl } from '../scripts/preview.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) { if (!server.listening) return; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
async function setup(t, handler, options = {}) {
  const webRoot = await mkdtemp(join(tmpdir(), 'robocell-bridge-'));
  await writeFile(join(webRoot, 'index.html'), '<h1>RoboCell</h1>');
  await writeFile(join(webRoot, 'studio.html'), '<h1>3D studio</h1>');
  await mkdir(join(webRoot, 'vendor'));
  await writeFile(join(webRoot, 'vendor', 'test.wasm'), Buffer.from([0, 97, 115, 109]));
  const calls = [];
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    calls.push({ path: req.url, method: req.method, body: Buffer.concat(chunks).toString(), headers: req.headers });
    if (handler) return handler(req, res);
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, sim_alive: false }));
  });
  const target = await listen(upstream);
  const server = createPreviewServer({ webRoot, isaacBaseUrl: target, ...options });
  const origin = await listen(server);
  t.after(async () => { await close(server); await close(upstream); await rm(webRoot, { recursive: true, force: true }); });
  return { origin, target, server, upstream, calls };
}

test('operator configuration rejects credentials, alternate schemes, query and paths', () => {
  for (const url of ['file:///x', 'http://a:b@localhost', 'http://localhost/private', 'http://localhost?x=1', 'http://localhost#x']) assert.throws(() => validateIsaacBaseUrl(url));
  assert.equal(validateIsaacBaseUrl('http://192.168.0.19:8210').origin, 'http://192.168.0.19:8210');
});

test('serves static HTML extension routes and wasm with correct MIME', async t => {
  const { origin } = await setup(t);
  const page = await fetch(`${origin}/studio`); assert.equal(page.status, 200); assert.match(await page.text(), /3D studio/);
  const wasm = await fetch(`${origin}/vendor/test.wasm`); assert.equal(wasm.headers.get('content-type'), 'application/wasm');
  assert.equal((await fetch(`${origin}/%5c..%5cpackage.json`)).status, 400);
  assert.equal((await fetch(`${origin}/missing.json`)).status, 404);
});

test('only configured destination is reachable, connection metadata does not imply health', async t => {
  const { origin, target, calls } = await setup(t);
  const metadata = await (await fetch(`${origin}/isaac/connection`)).json();
  assert.equal(metadata.target, target); assert.equal(metadata.configured, true); assert.equal(metadata.ok, undefined);
  const health = await (await fetch(`${origin}/isaac/health?target=http://example.invalid`)).json();
  assert.equal(health.ok, true); assert.equal(calls.length, 1);
  assert.equal((await fetch(`${origin}/isaac/admin`)).status, 404);
  assert.equal((await fetch(`${origin}/isaac/api/jobs/a/delete`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
});

test('control validates origin, method and JSON before forwarding', async t => {
  const { origin, calls } = await setup(t);
  const endpoint = `${origin}/isaac/api/control`;
  assert.equal((await fetch(endpoint)).status, 405);
  assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: 'invalid' })).status, 400);
  assert.equal(calls.length, 0);
  const response = await fetch(endpoint, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Authorization: 'do-not-forward' }, body: '{"cmd":"pause"}' });
  assert.equal(response.status, 200); assert.deepEqual(JSON.parse(calls[0].body), { cmd: 'pause' });
  assert.equal(calls[0].headers.authorization, undefined);
});

test('job-start supports empty JSON body and preserves upstream busy status', async t => {
  const { origin, calls } = await setup(t, (req, res) => { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end('{"error":"sim_busy"}'); });
  const response = await fetch(`${origin}/isaac/api/jobs/job_123/start`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' } });
  assert.equal(response.status, 409); assert.equal((await response.json()).error, 'sim_busy'); assert.equal(calls[0].body, '{}');
});

test('job-stop requires an explicit same-origin POST and targets only the supplied job', async t => {
  const { origin, calls } = await setup(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"job_id":"job_123","stopped":true}');
  });
  const endpoint = `${origin}/isaac/api/jobs/job_123/stop`;
  assert.equal((await fetch(endpoint)).status, 405);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal(calls.length, 0);
  const response = await fetch(endpoint, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { job_id: 'job_123', stopped: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/api/jobs/job_123/stop');
  assert.equal(calls[0].body, '{}');
});

test('job details permit only a bounded ID and read-only GET, preserving upstream failures', async t => {
  const { origin, calls } = await setup(t, (req, res) => {
    const status = req.url.includes('missing') ? 404 : req.url.includes('unready') ? 503 : 200;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { job_id: 'job_123', log_tail: 'actual log' } : { error: 'upstream failure' }));
  });
  const detail = await fetch(`${origin}/isaac/api/jobs/job_123`);
  assert.equal(detail.status, 200); assert.equal((await detail.json()).log_tail, 'actual log');
  assert.equal(calls[0].path, '/api/jobs/job_123'); assert.equal(calls[0].method, 'GET');
  for (const id of ['a', 'x'.repeat(65), 'abc%2Fdelete', 'abc%252Fdelete', 'abc.d']) {
    assert.equal((await fetch(`${origin}/isaac/api/jobs/${id}`)).status, 404);
  }
  assert.equal((await fetch(`${origin}/isaac/api/jobs`)).status, 404);
  assert.equal((await fetch(`${origin}/isaac/api/jobs/job_123`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 405);
  assert.equal((await fetch(`${origin}/isaac/api/jobs/job_123`, { headers: { Origin: 'https://foreign.invalid' } })).status, 403);
  assert.equal(calls.length, 1);
  assert.equal((await fetch(`${origin}/isaac/api/jobs/missing`)).status, 404);
  assert.equal((await fetch(`${origin}/isaac/api/jobs/unready`)).status, 503);
});

test('MJPEG is forwarded as a stream with its boundary', async t => {
  const data = '--frame\r\nContent-Type: image/jpeg\r\n\r\nJPEG\r\n';
  const { origin } = await setup(t, (req, res) => { res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame' }); res.write(data); res.end('--frame--'); });
  const response = await fetch(`${origin}/isaac/stream.mjpg`);
  assert.match(response.headers.get('content-type'), /boundary=frame/); assert.equal(await response.text(), data + '--frame--');
});

test('offline and timeout states are explicit errors, never synthetic simulation data', async t => {
  const { origin, upstream } = await setup(t);
  await close(upstream);
  const response = await fetch(`${origin}/isaac/health`);
  assert.equal(response.status, 502); assert.equal((await response.json()).code, 'ISAAC_UNREACHABLE');
  const slow = await setup(t, () => {}, { proxyTimeoutMs: 40 });
  const timed = await fetch(`${slow.origin}/isaac/health`);
  assert.equal(timed.status, 504); assert.equal((await timed.json()).code, 'ISAAC_TIMEOUT');
});

test('request payload size is bounded', async t => {
  const { origin, calls } = await setup(t, null, { maxBodyBytes: 20 });
  const response = await fetch(`${origin}/isaac/api/factory`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'a'.repeat(100) }) });
  assert.equal(response.status, 413); assert.equal(calls.length, 0);
});
