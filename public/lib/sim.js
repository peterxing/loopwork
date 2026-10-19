/*!
 * LoopWork sim: a deterministic 2D "humanoid hand" manipulation world.
 * The exact same file runs in the browser (live teleoperation) and on the server
 * (replay verification, fleet simulation, policy evaluation), so a submitted
 * demonstration can be re-simulated bit-for-bit to check what really happened.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LoopSim = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const HZ = 20; // control steps per second
  const WORLD = Object.freeze({ w: 100, h: 60 });
  const VMAX = 1.6; // world units per step at full stick
  const FRAGILE_V = 0.72; // max safe speed while grasping/carrying fragile items
  const PRECISION = 0.3; // precision-mode stick scale (0.48 u/step: 67% of FRAGILE_V, a margin robots can copy)
  const GRASP_R = 2.5;
  const T_MAX = 400; // 20 s episode limit

  const BINS = Object.freeze({
    shelf: { id: 'shelf', label: 'Stock shelf', x: 88, y: 11, hw: 8, hh: 6.5 },
    rack: { id: 'rack', label: 'Dish rack', x: 88, y: 30, hw: 8, hh: 6.5 },
    basket: { id: 'basket', label: 'Laundry basket', x: 88, y: 49, hw: 8, hh: 6.5 },
  });

  const OBJECTS = Object.freeze({
    box: { id: 'box', label: 'Parcel box', bin: 'shelf', fragile: false },
    glass: { id: 'glass', label: 'Wine glass', bin: 'rack', fragile: true },
    towel: { id: 'towel', label: 'Bath towel', bin: 'basket', fragile: false },
    plate: { id: 'plate', label: 'Dinner plate', bin: 'rack', fragile: true },
  });

  const SKILLS = Object.freeze({
    stock_shelf: { id: 'stock_shelf', name: 'Stock shelves', object: 'box', revenueCents: 240, setting: 'warehouses & retail', verb: 'shelve a parcel' },
    handle_glassware: { id: 'handle_glassware', name: 'Handle glassware', object: 'glass', revenueCents: 320, setting: 'bars, cafes & restaurants', verb: 'rack a wine glass' },
    sort_laundry: { id: 'sort_laundry', name: 'Sort laundry', object: 'towel', revenueCents: 280, setting: 'hotels & aged care', verb: 'bin a used towel' },
    load_plates: { id: 'load_plates', name: 'Rack dinner plates', object: 'plate', revenueCents: 300, setting: 'commercial kitchens', verb: 'rack a dinner plate' },
  });

  const SKILL_BY_OBJECT = {};
  Object.keys(SKILLS).forEach(function (id) { SKILL_BY_OBJECT[SKILLS[id].object] = id; });

  const FAILURES = Object.freeze({
    broke_fragile: { id: 'broke_fragile', label: 'Broke a fragile item', short: 'breakage', damageCents: 600 },
    wrong_bin: { id: 'wrong_bin', label: 'Put item in the wrong place', short: 'wrong place', damageCents: 80 },
    dropped: { id: 'dropped', label: 'Dropped item outside a bin', short: 'dropped', damageCents: 150 },
    timeout: { id: 'timeout', label: 'Stalled and timed out', short: 'stalled', damageCents: 0 },
  });

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /** Stick values are quantised to 0.01 so client and server apply identical actions. */
  function quant(v) {
    const c = clamp(Number(v) || 0, -1, 1);
    return Math.round(c * 100) / 100;
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function r2(v) { return Math.round(v * 100) / 100; }

  function makeEpisode(rand, type) {
    if (!OBJECTS[type]) throw new Error('Unknown object type: ' + type);
    return {
      type: type,
      ox: r2(6 + rand() * 52),
      oy: r2(6 + rand() * 48),
      gx: r2(64 + rand() * 8),
      gy: r2(18 + rand() * 24),
    };
  }

  /** init may include held:true for mid-task handovers (robot asks a human to take over). */
  function reset(init) {
    if (!init || !OBJECTS[init.type]) throw new Error('Invalid episode');
    const held = !!init.held;
    return {
      type: init.type,
      gx: Number(init.gx), gy: Number(init.gy),
      ox: held ? Number(init.gx) : Number(init.ox), oy: held ? Number(init.gy) : Number(init.oy),
      held: held, t: 0, done: false, success: false, failure: null, bin: null,
      speed: 0, maxHeldSpeed: 0, path: 0, misses: 0, grasps: 0,
    };
  }

  function handoverInit(s) {
    const out = { type: s.type, gx: r2(s.gx), gy: r2(s.gy), ox: r2(s.ox), oy: r2(s.oy) };
    if (s.held) out.held = true;
    return out;
  }

  function binAt(x, y) {
    for (const id in BINS) {
      const b = BINS[id];
      if (Math.abs(x - b.x) <= b.hw && Math.abs(y - b.y) <= b.hh) return id;
    }
    return null;
  }

  function finish(s, success, failure, bin) {
    s.done = true; s.success = success; s.failure = failure; s.bin = bin || null;
    return s;
  }

  /** Advance one control step. a = [stickX, stickY, grip] with grip 0 none, 1 grasp, 2 release. */
  function step(s, a) {
    if (s.done) return s;
    let ax = quant(a[0]);
    let ay = quant(a[1]);
    const g = a[2] === 1 || a[2] === 2 ? a[2] : 0;
    const n2 = ax * ax + ay * ay;
    if (n2 > 1) { const n = Math.sqrt(n2); ax = ax / n; ay = ay / n; }
    const vx = ax * VMAX;
    const vy = ay * VMAX;
    const speed = Math.sqrt(vx * vx + vy * vy);
    s.gx = clamp(s.gx + vx, 0, WORLD.w);
    s.gy = clamp(s.gy + vy, 0, WORLD.h);
    s.t += 1;
    s.path += speed;
    s.speed = speed;
    const fragile = OBJECTS[s.type].fragile;
    if (s.held) {
      s.ox = s.gx; s.oy = s.gy;
      if (speed > s.maxHeldSpeed) s.maxHeldSpeed = speed;
      if (fragile && speed > FRAGILE_V) return finish(s, false, 'broke_fragile');
    }
    if (g === 1 && !s.held) {
      const dx = s.ox - s.gx;
      const dy = s.oy - s.gy;
      if (dx * dx + dy * dy <= GRASP_R * GRASP_R) {
        if (fragile && speed > FRAGILE_V) return finish(s, false, 'broke_fragile');
        s.held = true; s.grasps += 1; s.ox = s.gx; s.oy = s.gy;
      } else {
        s.misses += 1;
      }
    } else if (g === 2 && s.held) {
      s.held = false;
      const bin = binAt(s.ox, s.oy);
      if (bin === OBJECTS[s.type].bin) return finish(s, true, null, bin);
      return finish(s, false, bin ? 'wrong_bin' : 'dropped', bin);
    }
    if (s.t >= T_MAX) return finish(s, false, 'timeout');
    return s;
  }

  function frame(s) { return [r2(s.gx), r2(s.gy), r2(s.ox), r2(s.oy), s.held ? 1 : 0]; }

  function normAction(a) { return [quant(a[0]), quant(a[1]), a[2] === 1 || a[2] === 2 ? a[2] : 0]; }

  /** Run a controller until the episode ends. */
  function rollout(init, act, opts) {
    const s = reset(init);
    const actions = [];
    const frames = opts && opts.frames ? [frame(s)] : null;
    while (!s.done) {
      const a = normAction(act(s));
      actions.push(a);
      step(s, a);
      if (frames) frames.push(frame(s));
    }
    return { state: s, actions: actions, frames: frames };
  }

  /** Compact wire/storage format: flat ints [x*100, y*100, grip, ...]. */
  function encodeActions(actions) {
    const out = new Array(actions.length * 3);
    for (let i = 0; i < actions.length; i++) {
      const a = normAction(actions[i]);
      out[3 * i] = Math.round(a[0] * 100);
      out[3 * i + 1] = Math.round(a[1] * 100);
      out[3 * i + 2] = a[2];
    }
    return out;
  }

  function decodeAction(flat, i) { return [flat[3 * i] / 100, flat[3 * i + 1] / 100, flat[3 * i + 2]]; }

  function validateActions(flat) {
    if (!Array.isArray(flat) || flat.length % 3 !== 0) return 'actions must be a flat array of [x, y, grip] triples';
    if (flat.length > T_MAX * 3) return 'too many actions';
    for (let i = 0; i < flat.length; i += 3) {
      const x = flat[i], y = flat[i + 1], g = flat[i + 2];
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < -100 || x > 100 || y < -100 || y > 100) return 'stick values must be integers in [-100, 100]';
      if (g !== 0 && g !== 1 && g !== 2) return 'grip must be 0, 1 or 2';
    }
    return null;
  }

  /** Replay flat actions; onStep(preState, action, index) is called before each step. */
  function replay(init, flat, onStep) {
    const s = reset(init);
    const n = Math.floor(flat.length / 3);
    for (let i = 0; i < n && !s.done; i++) {
      const a = decodeAction(flat, i);
      if (onStep) onStep(s, a, i);
      step(s, a);
    }
    return s;
  }

  function dist(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return Math.sqrt(dx * dx + dy * dy); }

  /** Server-side QA for a teleoperated demonstration (re-simulated from scratch). */
  function demoMetrics(init, flat) {
    const s = reset(init);
    const n = Math.floor(flat.length / 3);
    let jerk = 0, idle = 0, px = 0, py = 0;
    for (let i = 0; i < n && !s.done; i++) {
      const a = decodeAction(flat, i);
      step(s, a);
      if (i > 0) jerk += Math.abs(a[0] - px) + Math.abs(a[1] - py);
      if (s.speed < 0.08) idle += 1;
      px = a[0]; py = a[1];
    }
    const obj = OBJECTS[s.type];
    const bin = BINS[obj.bin];
    const ideal = init.held
      ? Math.max(1, dist(init.gx, init.gy, bin.x, bin.y) - 4)
      : Math.max(1, dist(init.gx, init.gy, init.ox, init.oy) + dist(init.ox, init.oy, bin.x, bin.y) - 4);
    const steps = Math.max(1, s.t);
    const efficiency = s.path > 0 ? clamp(ideal / s.path, 0, 1) : 0;
    const smoothness = 1 - clamp(jerk / steps / 0.35, 0, 1);
    const safety = obj.fragile ? clamp((1 - s.maxHeldSpeed / FRAGILE_V) / 0.25, 0, 1) : 1;
    const idleRatio = idle / steps;
    let qa = 0;
    if (s.success) qa = clamp(0.4 + 0.25 * efficiency + 0.15 * smoothness + 0.2 * safety - 0.5 * Math.max(0, idleRatio - 0.35), 0, 1);
    return {
      success: s.success, failure: s.failure, steps: s.t, bin: s.bin,
      efficiency: r2(efficiency), smoothness: r2(smoothness), safety: r2(safety), idleRatio: r2(idleRatio),
      misses: s.misses, maxHeldSpeed: r2(s.maxHeldSpeed), qa: r2(qa),
    };
  }

  /**
   * A scripted human-like operator used for simulated contributors and for the
   * (simulated) retargeting of smart-glasses hand trajectories into robot actions.
   */
  function scriptedOperator(init, profile, rand) {
    const p = Object.assign({ precision: 0.8, pace: 0.85, care: 0.9, sortAccuracy: 0.97 }, profile || {});
    const obj = OBJECTS[init.type];
    let binId = obj.bin;
    if (rand() > p.sortAccuracy) {
      const others = Object.keys(BINS).filter(function (b) { return b !== obj.bin; });
      binId = others[Math.floor(rand() * others.length)];
    }
    const bin = BINS[binId];
    const dropX = bin.x + (rand() * 2 - 1) * bin.hw * 0.45;
    const dropY = bin.y + (rand() * 2 - 1) * bin.hh * 0.45;
    const careful = rand() < p.care;
    const fragileCap = obj.fragile ? FRAGILE_V * (careful ? 0.72 + 0.2 * rand() : 1.08 + 0.35 * rand()) : Infinity;
    const pace = VMAX * clamp(p.pace * (0.88 + 0.12 * rand()), 0.3, 1);
    const jitter = (1 - p.precision) * 0.6;
    const graspAt = 1.2 + rand() * 0.9;
    const releaseAt = 0.9 + rand() * 0.9;
    let wobble = 0, pause = 0;
    return function act(s) {
      wobble = wobble * 0.85 + (rand() * 2 - 1) * jitter * 0.35;
      if (pause > 0) { pause -= 1; return [0, 0, 0]; }
      if (rand() < 0.012 * (1.2 - p.precision)) pause = 1 + Math.floor(rand() * 4);
      const tx = s.held ? dropX : s.ox;
      const ty = s.held ? dropY : s.oy;
      const dx = tx - s.gx, dy = ty - s.gy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (!s.held && d <= graspAt) return [0, 0, 1];
      if (s.held && d <= releaseAt) return [0, 0, 2];
      let ux = dx / d, uy = dy / d;
      const qx = ux - uy * wobble, qy = uy + ux * wobble;
      const qn = Math.sqrt(qx * qx + qy * qy) || 1;
      ux = qx / qn; uy = qy / qn;
      const sp = Math.min(pace, fragileCap, 0.3 * d + 0.12);
      return [ux * sp / VMAX, uy * sp / VMAX, 0];
    };
  }

  return {
    HZ: HZ, WORLD: WORLD, VMAX: VMAX, FRAGILE_V: FRAGILE_V, PRECISION: PRECISION, GRASP_R: GRASP_R, T_MAX: T_MAX,
    BINS: BINS, OBJECTS: OBJECTS, SKILLS: SKILLS, SKILL_BY_OBJECT: SKILL_BY_OBJECT, FAILURES: FAILURES,
    clamp: clamp, quant: quant, mulberry32: mulberry32, makeEpisode: makeEpisode, reset: reset, step: step,
    binAt: binAt, frame: frame, handoverInit: handoverInit, rollout: rollout, encodeActions: encodeActions, decodeAction: decodeAction,
    validateActions: validateActions, replay: replay, demoMetrics: demoMetrics, scriptedOperator: scriptedOperator,
  };
});
