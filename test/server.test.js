'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Sim = require('../public/lib/sim.js');
const { createServer } = require('../server.js');

let app, base, dataDir;

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loopwork-test-'));
  app = createServer({ dataDir: dataDir, reset: true, log: false });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + app.server.address().port;
});

test.after(async () => {
  await new Promise((r) => app.server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function api(method, url, body) {
  const res = await fetch(base + url, { method: method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

test('serves the web app and blocks path traversal', async () => {
  const index = await fetch(base + '/');
  assert.equal(index.status, 200);
  assert.match(await index.text(), /LoopWork/);
  const js = await fetch(base + '/lib/sim.js');
  assert.match(js.headers.get('content-type'), /javascript/);
  const evil = await fetch(base + '/..%2f..%2fserver.js');
  assert.ok(evil.status === 403 || evil.status === 404);
});

test('API: overview, unknown endpoints and bad JSON', async () => {
  const ov = await api('GET', '/api/overview');
  assert.equal(ov.status, 200);
  assert.equal(ov.body.deployed.version, 1);
  assert.equal((await api('GET', '/api/nope')).status, 404);
  const bad = await fetch(base + '/api/train', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400);
});

test('API: full takeover over HTTP is verified server-side and persisted', async () => {
  const bounties = (await api('GET', '/api/bounties?workerId=w_you')).body.bounties;
  const iv = bounties.find((b) => b.kind === 'intervention');
  const iss = await api('POST', '/api/episodes', { workerId: 'w_you', bountyId: iv.id });
  assert.equal(iss.status, 200);
  const init = iss.body.episode.init;
  const r = Sim.mulberry32(5);
  const res = Sim.rollout(init, Sim.scriptedOperator(init, { precision: 0.95, care: 1, sortAccuracy: 1 }, r));
  const sub = await api('POST', '/api/episodes/' + iss.body.episode.id + '/submit', {
    workerId: 'w_you', actions: Sim.encodeActions(res.actions), clientOutcome: { success: res.state.success, steps: res.state.t },
  });
  assert.equal(sub.status, 200);
  assert.equal(sub.body.verified, true);
  assert.ok(sub.body.session.flags.indexOf('faster_than_realtime') >= 0, 'an instant scripted submission is flagged');
  assert.equal(sub.body.session.status, 'review');
  const again = await api('POST', '/api/episodes/' + iss.body.episode.id + '/submit', { workerId: 'w_you', actions: [] });
  assert.equal(again.status, 409);
  app.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.ok(saved.sessions.some((s) => s.id === sub.body.session.id));
});

test('API: loop cycle and payout endpoints work end to end', async () => {
  const cyc = await api('POST', '/api/loop/cycle', {});
  assert.equal(cyc.status, 200);
  assert.equal(cyc.body.cycle.stages.length, 8);
  const ops = (await api('GET', '/api/ops')).body;
  const payee = ops.balances.find((b) => b.available > 0);
  const paid = await api('POST', '/api/payouts', { workerId: payee.worker.id });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.balances.available, 0);
  const cfg = await api('PATCH', '/api/config', { royaltyRate: 0.15 });
  assert.equal(cfg.body.config.royaltyRate, 0.15);
  assert.equal((await api('PATCH', '/api/config', { royaltyRate: 'lots' })).status, 400);
});
