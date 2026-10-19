'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Sim = require('../public/lib/sim.js');
const Policy = require('../public/lib/policy.js');

const EXPERT = { precision: 0.93, pace: 0.9, care: 0.97, sortAccuracy: 1 };

function demos(type, n, seed) {
  const r = Sim.mulberry32(seed);
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < n * 10) {
    const init = Sim.makeEpisode(r, type);
    const res = Sim.rollout(init, Sim.scriptedOperator(init, EXPERT, r));
    if (res.state.success) out.push({ init: init, actions: Sim.encodeActions(res.actions), weight: 1 });
  }
  return out;
}
function rate(policy, type) {
  const ev = Policy.evaluate(policy, Policy.evalSuite([type], 20, 777));
  return ev[type].ok / ev[type].n;
}

const boxes = demos('box', 12, 1);

test('a policy trained only on boxes shelves boxes reliably', () => {
  assert.ok(rate(Policy.build(boxes), 'box') >= 0.85);
});

test('missing data shows up as realistic failure modes', () => {
  const p = Policy.build(boxes);
  const glass = Policy.evaluate(p, Policy.evalSuite(['glass'], 20, 777)).glass;
  const towel = Policy.evaluate(p, Policy.evalSuite(['towel'], 20, 777)).towel;
  assert.ok(glass.ok <= 2, 'untrained glassware mostly fails');
  assert.ok((glass.modes.broke_fragile || 0) >= 10, 'and mostly by breaking glasses');
  assert.ok(towel.ok <= 2, 'untrained laundry mostly fails');
  assert.ok((towel.modes.wrong_bin || 0) + (towel.modes.timeout || 0) >= 15);
});

test('a few targeted demos close a skill gap', () => {
  const before = rate(Policy.build(boxes), 'towel');
  const after = rate(Policy.build(boxes.concat(demos('towel', 4, 3))), 'towel');
  assert.ok(after >= 0.8, 'towel success after 4 demos: ' + after);
  assert.ok(after - before >= 0.6);
  const glassAfter = rate(Policy.build(boxes.concat(demos('glass', 6, 2))), 'glass');
  assert.ok(glassAfter >= 0.7, 'glass success after 6 demos: ' + glassAfter);
});

test('evaluation is deterministic (common random numbers)', () => {
  const p = Policy.build(boxes.concat(demos('glass', 4, 2)));
  const suite = Policy.evalSuite(['box', 'glass'], 10, 99);
  assert.deepEqual(Policy.evaluate(p, suite), Policy.evaluate(p, suite));
});

test('a policy with no data stands still rather than guessing', () => {
  const p = Policy.build([]);
  assert.deepEqual(p.act(Sim.reset(Sim.makeEpisode(Sim.mulberry32(1), 'box'))), [0, 0, 0]);
});
