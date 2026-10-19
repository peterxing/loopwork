'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Sim = require('../public/lib/sim.js');

function scripted(type, seed, profile) {
  const r = Sim.mulberry32(seed);
  const init = Sim.makeEpisode(r, type);
  const res = Sim.rollout(init, Sim.scriptedOperator(init, Object.assign({ precision: 0.95, pace: 0.9, care: 1, sortAccuracy: 1 }, profile), r));
  return { init: init, res: res };
}

test('episodes are deterministic for a given seed', () => {
  const a = Sim.makeEpisode(Sim.mulberry32(42), 'glass');
  const b = Sim.makeEpisode(Sim.mulberry32(42), 'glass');
  assert.deepEqual(a, b);
  assert.ok(a.ox < 60 && a.gx >= 64, 'object spawns in the pick-up area, gripper outside it');
});

test('replaying encoded actions reproduces the live outcome exactly', () => {
  for (const type of Object.keys(Sim.OBJECTS)) {
    const { init, res } = scripted(type, 7);
    const flat = Sim.encodeActions(res.actions);
    assert.equal(Sim.validateActions(flat), null);
    const replayed = Sim.replay(init, flat);
    assert.equal(replayed.success, res.state.success, type);
    assert.equal(replayed.t, res.state.t, type);
    assert.equal(replayed.gx, res.state.gx, type);
    assert.equal(replayed.gy, res.state.gy, type);
  }
});

test('a careful operator succeeds and puts each item in its own bin', () => {
  for (const type of Object.keys(Sim.OBJECTS)) {
    const { res } = scripted(type, 11);
    assert.equal(res.state.success, true, type + ' should succeed');
    assert.equal(res.state.bin, Sim.OBJECTS[type].bin);
  }
});

test('carrying a fragile item too fast breaks it', () => {
  const s = Sim.reset({ type: 'glass', gx: 30, gy: 30, ox: 30, oy: 30 });
  Sim.step(s, [0, 0, 1]);
  assert.equal(s.held, true);
  Sim.step(s, [1, 0, 0]);
  assert.equal(s.done, true);
  assert.equal(s.failure, 'broke_fragile');
});

test('precision mode is safely below the fragile speed limit', () => {
  assert.ok(Sim.PRECISION * Sim.VMAX < Sim.FRAGILE_V * 0.75);
  const s = Sim.reset({ type: 'glass', gx: 30, gy: 30, ox: 30, oy: 30 });
  Sim.step(s, [0, 0, 1]);
  for (let i = 0; i < 20; i++) Sim.step(s, [Sim.PRECISION, 0, 0]);
  assert.equal(s.done, false);
  assert.equal(s.held, true);
});

test('wrong bin and drops are reported as distinct failures', () => {
  const towel = Sim.reset({ type: 'towel', gx: 88, gy: 11, ox: 88, oy: 11 });
  Sim.step(towel, [0, 0, 1]);
  Sim.step(towel, [0, 0, 2]);
  assert.equal(towel.failure, 'wrong_bin');
  const box = Sim.reset({ type: 'box', gx: 40, gy: 30, ox: 40, oy: 30 });
  Sim.step(box, [0, 0, 1]);
  Sim.step(box, [0, 0, 2]);
  assert.equal(box.failure, 'dropped');
});

test('handover inits start mid-task with the item already held', () => {
  const s = Sim.reset({ type: 'glass', gx: 50, gy: 20, ox: 1, oy: 1, held: true });
  assert.equal(s.held, true);
  assert.equal(s.ox, 50);
  assert.equal(s.oy, 20);
});

test('action validation rejects malformed payloads', () => {
  assert.ok(Sim.validateActions([1, 2]));
  assert.ok(Sim.validateActions([0.5, 0, 0]));
  assert.ok(Sim.validateActions([0, 0, 3]));
  assert.ok(Sim.validateActions(new Array(Sim.T_MAX * 3 + 3).fill(0)));
  assert.equal(Sim.validateActions([100, -100, 2]), null);
});

test('demo metrics give zero QA to failures and high QA to clean demos', () => {
  const { init, res } = scripted('box', 5);
  const m = Sim.demoMetrics(init, Sim.encodeActions(res.actions));
  assert.ok(m.qa > 0.8, 'clean demo QA ' + m.qa);
  const bad = Sim.demoMetrics({ type: 'glass', gx: 30, gy: 30, ox: 30, oy: 30 }, [0, 0, 1, 100, 0, 0]);
  assert.equal(bad.success, false);
  assert.equal(bad.qa, 0);
});
