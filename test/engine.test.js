'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Sim = require('../public/lib/sim.js');
const E = require('../public/lib/engine.js');

const T0 = Date.UTC(2026, 9, 18, 9, 0, 0);
const CAREFUL = { precision: 0.95, pace: 0.85, care: 1, sortAccuracy: 1 };

function fresh() { return { state: E.createState({ now: T0, seed: 1234 }), rt: E.createRuntime() }; }
function call(box, op, args, now, ctx) { return E.dispatch(box, op, args || {}, Object.assign({ now: now || T0 }, ctx || {})); }
function solve(init, seed) {
  const r = Sim.mulberry32(seed || 9);
  const res = Sim.rollout(init, Sim.scriptedOperator(init, CAREFUL, r));
  return { flat: Sim.encodeActions(res.actions), state: res.state };
}
/** Issue + solve + submit an episode in (simulated) real time. */
function doEpisode(box, workerId, args, t, seed) {
  const iss = call(box, 'issueEpisode', Object.assign({ workerId: workerId }, args), t);
  const sol = solve(iss.episode.init, seed);
  const done = t + sol.state.t * 50 + 1000;
  const sub = call(box, 'submitEpisode', { workerId: workerId, episodeId: iss.episode.id, actions: sol.flat, clientOutcome: { success: sol.state.success, steps: sol.state.t } }, done);
  return { iss: iss, sub: sub, t: done };
}
function shiftDividends(box, shiftId) {
  return box.state.ledger.filter((e) => e.kind === 'royalty' && e.ref === shiftId).reduce((a, e) => a + e.cents, 0);
}

test('the pilot seeds a deployed v1, a fleet shift and priced bounties', () => {
  const box = fresh();
  const ov = call(box, 'overview');
  assert.equal(ov.deployed.version, 1);
  assert.equal(ov.shiftNo, 1);
  assert.ok(ov.kpis.fleetSuccess < 0.7, 'pilot fleet has clear gaps');
  const b = call(box, 'bounties', { workerId: 'w_you' }).bounties;
  assert.ok(b.some((x) => x.kind === 'intervention'), 'takeover bounties exist');
  assert.ok(b.some((x) => x.kind === 'skill' && x.skill === 'handle_glassware'));
  assert.ok(b.some((x) => x.kind === 'capture' && x.mode === 'glasses'));
});

test('teleop takeover: server re-simulates, pays time + bounty + quality, fills the bounty', () => {
  const box = fresh();
  const iv = call(box, 'bounties', { workerId: 'w_you' }).bounties.find((x) => x.kind === 'intervention');
  const { sub } = doEpisode(box, 'w_you', { bountyId: iv.id }, T0 + 1000);
  assert.equal(sub.verified, true);
  assert.equal(sub.session.outcome.success, true);
  assert.equal(sub.session.status, 'approved');
  const pay = sub.session.pay;
  assert.equal(pay.bountyCents, iv.rateCents);
  assert.equal(pay.totalCents, pay.baseCents + pay.bountyCents + pay.qualityCents);
  assert.equal(sub.bounty.status, 'filled');
  assert.equal(sub.balances.available, pay.totalCents);
  const demo = box.state.demos.find((d) => d.id === sub.session.demoIds[0]);
  assert.equal(demo.intervention, true);
  assert.equal(demo.status, 'approved');
});

test('episodes cannot be replayed, stolen or submitted faster than real time', () => {
  const box = fresh();
  const iss = call(box, 'issueEpisode', { workerId: 'w_you', skill: 'stock_shelf' }, T0);
  const sol = solve(iss.episode.init);
  assert.throws(() => call(box, 'submitEpisode', { workerId: 'w_kofi', episodeId: iss.episode.id, actions: sol.flat }, T0 + 60000), (e) => e.status === 403);
  const sub = call(box, 'submitEpisode', { workerId: 'w_you', episodeId: iss.episode.id, actions: sol.flat, clientOutcome: { success: !sol.state.success, steps: 1 } }, T0 + 10);
  assert.deepEqual(sub.session.flags.sort(), ['faster_than_realtime', 'replay_mismatch']);
  assert.equal(sub.session.status, 'review');
  assert.equal(sub.balances.available, sub.session.pay.baseCents, 'only time pay is released before review');
  assert.throws(() => call(box, 'submitEpisode', { workerId: 'w_you', episodeId: iss.episode.id, actions: sol.flat }, T0 + 60000), (e) => e.status === 409);
  assert.throws(() => call(box, 'submitEpisode', { workerId: 'w_you', episodeId: 'nope', actions: [] }, T0), (e) => e.status === 404);
});

test('review approval releases pending pay; rejection voids the bonus but keeps time pay', () => {
  const box = fresh();
  const bounty = call(box, 'bounties', { workerId: 'w_you' }).bounties.find((x) => x.kind === 'skill');
  const outcomes = [];
  for (const decision of ['approve', 'reject']) {
    const iss = call(box, 'issueEpisode', { workerId: 'w_you', bountyId: bounty.id }, T0);
    const sol = solve(iss.episode.init, decision === 'approve' ? 3 : 4);
    const sub = call(box, 'submitEpisode', { workerId: 'w_you', episodeId: iss.episode.id, actions: sol.flat }, T0 + 5);
    assert.equal(sub.session.status, 'review');
    const before = call(box, 'workerDetail', { workerId: 'w_you' }).balances;
    call(box, 'reviewSession', { sessionId: sub.session.id, decision: decision }, T0 + 99999);
    const after = call(box, 'workerDetail', { workerId: 'w_you' }).balances;
    outcomes.push({ decision, before, after, bonus: sub.session.pay.bountyCents + sub.session.pay.qualityCents });
    assert.throws(() => call(box, 'reviewSession', { sessionId: sub.session.id, decision: 'approve' }), (e) => e.status === 409);
  }
  assert.equal(outcomes[0].after.available - outcomes[0].before.available, outcomes[0].bonus);
  assert.equal(outcomes[1].after.pending, outcomes[1].before.pending - outcomes[1].bonus);
  assert.equal(outcomes[1].after.available, outcomes[1].before.available);
});

test('glasses capture requires consent, rejects non-enrolled workers and gates dark footage to review', () => {
  const box = fresh();
  const cap = call(box, 'bounties', { workerId: 'w_you' }).bounties.find((x) => x.kind === 'capture');
  const good = { source: 'simulated', durationSec: 900, width: 1920, height: 1080, brightness: 125, sharpness: 80, stability: 0.85 };
  const consent = { siteConsent: true, bystanderNotice: true, privacyZones: true };
  assert.throws(() => call(box, 'submitGlasses', { workerId: 'w_you', bountyId: cap.id, media: good, consent: { siteConsent: true } }), (e) => e.status === 422);
  assert.throws(() => call(box, 'submitGlasses', { workerId: 'w_kofi', bountyId: cap.id, media: good, consent }), (e) => e.status === 403);
  const ok = call(box, 'submitGlasses', { workerId: 'w_you', bountyId: cap.id, media: good, consent }, T0 + 1);
  assert.equal(ok.session.status, 'approved');
  assert.ok(ok.session.retarget.yielded >= 1);
  assert.equal(ok.session.pay.baseCents, Math.round(box.state.config.glassesBaseCentsPerHour * 0.25));
  const dark = call(box, 'submitGlasses', { workerId: 'w_you', bountyId: cap.id, consent, media: Object.assign({}, good, { brightness: 30, sharpness: 20 }) }, T0 + 2);
  assert.equal(dark.session.status, 'review');
  assert.throws(() => call(box, 'submitGlasses', { workerId: 'w_you', skill: 'sort_laundry', consent, media: { durationSec: 2 } }), (e) => e.status === 422);
});

test('training credits the contributor whose data closed the gap, and dividends follow the credit', () => {
  const box = fresh();
  assert.throws(() => call(box, 'train', {}, T0), (e) => e.status === 409, 'nothing new to train on');
  const laundry = call(box, 'bounties', { workerId: 'w_you' }).bounties.find((x) => x.kind === 'skill' && x.skill === 'sort_laundry');
  let t = T0 + 1000;
  for (let i = 0; i < 3; i++) t = doEpisode(box, 'w_you', { bountyId: laundry.id }, t, 20 + i).t;
  const before = box.state.policies[0].bySkill.sort_laundry.success;
  const trained = call(box, 'train', {}, t).policy;
  assert.equal(trained.status, 'deployed');
  assert.ok(trained.bySkill.sort_laundry.success - before >= 0.5, 'laundry improved by at least 50 pts');
  const sum = trained.attribution.reduce((a, x) => a + x.share, 0);
  assert.ok(Math.abs(sum - 1) < 0.01, 'shares sum to 1, got ' + sum);
  const mine = trained.attribution.find((a) => a.worker === 'w_you');
  assert.ok(mine && mine.share > 0.2, 'you earn a meaningful share');
  const shift = call(box, 'runShift', {}, t + 1).shift;
  const pool = Math.floor(shift.revenueCents * box.state.config.royaltyRate);
  const paid = shiftDividends(box, shift.id);
  assert.ok(paid > 0 && paid <= pool && pool - paid < trained.attribution.length, 'dividends distribute the pool (minus rounding)');
  const myRoyalty = box.state.ledger.filter((e) => e.worker === 'w_you' && e.kind === 'royalty' && e.ref === shift.id).reduce((a, e) => a + e.cents, 0);
  assert.equal(myRoyalty, Math.floor(pool * mine.share));
});

test('safety gate blocks a regressing model and opt-out removes data from training', () => {
  const box = fresh();
  for (const id of ['w_kofi', 'w_priya']) call(box, 'updateConsent', { workerId: id, dataOptOut: true });
  const res = call(box, 'train', {}, T0 + 5).policy;
  assert.equal(res.status, 'blocked');
  assert.equal(res.gate.passed, false);
  assert.ok(res.gate.reasons.some((r) => /Stock shelves regressed/.test(r)));
  assert.equal(box.state.deployedVersion, 1, 'fleet stays on v1');
  const optedIds = new Set(box.state.demos.filter((d) => d.worker === 'w_kofi' || d.worker === 'w_priya').map((d) => d.id));
  assert.ok(res.excludedOptOut > 0);
  assert.ok(box.state.policies[1].demoIds.every((id) => !optedIds.has(id)));
  const v1Royalty = box.state.policies[0].attribution.find((a) => a.worker === 'w_kofi');
  assert.ok(v1Royalty.share > 0, 'models already trained keep paying opted-out contributors');
  const forced = call(box, 'deploy', { version: res.version }, T0 + 6).policy;
  assert.equal(forced.status, 'deployed', 'operators can override the gate explicitly');
});

test('payouts move available balance to paid out', () => {
  const box = fresh();
  const before = call(box, 'workerDetail', { workerId: 'w_kofi' }).balances;
  assert.ok(before.available > 0);
  const r = call(box, 'payout', { workerId: 'w_kofi' }, T0 + 1);
  assert.equal(r.receipt.amountCents, before.available);
  assert.equal(r.balances.available, 0);
  assert.equal(r.balances.paidOut, before.available);
  assert.throws(() => call(box, 'payout', { workerId: 'w_kofi' }), (e) => e.status === 409);
});

test('the loop improves the fleet, and a new site opens a new skill gap', () => {
  const box = fresh();
  const start = call(box, 'overview').kpis.fleetSuccess;
  let t = T0;
  for (let i = 0; i < 3; i++) call(box, 'runCycle', {}, (t += 3600e3));
  const mid = call(box, 'overview');
  assert.ok(mid.kpis.fleetSuccess >= start + 0.3, 'fleet ' + start + ' -> ' + mid.kpis.fleetSuccess);
  assert.ok(mid.kpis.royaltiesCents > 0);
  call(box, 'onboardSite', {}, (t += 1000));
  assert.throws(() => call(box, 'onboardSite', {}, t), (e) => e.status === 409);
  call(box, 'runShift', {}, (t += 1000));
  const plates = call(box, 'bounties', {}).bounties.filter((b) => b.skill === 'load_plates');
  assert.ok(plates.length > 0, 'plate bounties opened after the new site joined');
});

test('state survives JSON persistence and failure replays stay bit-exact', () => {
  const box = fresh();
  const ev = box.state.events[0];
  const restored = { state: JSON.parse(JSON.stringify(box.state)), rt: E.createRuntime() };
  const replay = call(restored, 'eventReplay', { eventId: ev.id });
  assert.equal(replay.outcome.failure, ev.failure);
  assert.equal(replay.outcome.steps, ev.steps);
  const f = replay.frames[replay.handoverIndex];
  assert.deepEqual([f[0], f[1]], [ev.handover.gx, ev.handover.gy]);
});

test('every route round-trips between the client request builder and the server matcher', () => {
  const sample = { workerId: 'w_you', episodeId: 'ep1', sessionId: 's1', eventId: 'ev1', version: 3 };
  for (const r of E.ROUTES) {
    const req = E.buildRequest(r.op, sample);
    const m = E.matchRoute(req.method, req.url.split('?')[0]);
    assert.ok(m, 'no match for ' + r.op);
    assert.equal(m.route.op, r.op);
  }
  assert.equal(E.matchRoute('DELETE', '/api/overview'), null);
});
