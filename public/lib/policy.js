/*!
 * LoopWork policy: structured k-nearest-neighbour behaviour cloning.
 *
 * From approved demonstrations it learns, per object type:
 *   - HOW to reach for the item (goal-relative, so it generalises from a few demos),
 *   - WHERE to carry it and HOW FAST: a position -> velocity field near demonstrated paths,
 *     blended with servoing to the drop-off point the demonstrators used where coverage is
 *     thin. Sorting rules and care with fragile items both come from the data,
 *   - WHEN to grasp / release (event actions, gated on nearby evidence).
 * Under actuation noise, demos carried close to a fragile item's speed limit produce
 * breakages. Takeovers by careful humans at exactly those moments fix them (the DAgger effect).
 * Missing or low-quality data produces the failure modes a real fleet sees:
 * broken glassware, items in the wrong place, stalls.
 *
 * It is deliberately tiny so the whole loop (train -> evaluate -> attribute value
 * to each contributor -> gate -> deploy) runs in milliseconds. In production this
 * slot is a VLA / diffusion-policy fine-tune; the loop around it is the same.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./sim.js'));
  else root.LoopPolicy = factory(root.LoopSim);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Sim) {
  'use strict';

  const K = 7;
  const CELL = 3;
  const MIN_BUCKET = 15; // below this many samples, fall back to generic (all-object) behaviour
  const BOOST = [1, 3, 3]; // grasp/release events are rare, so up-weight their votes
  const SMEAR = 1; // also label the step just before a grasp as "grasp intent"
  const EVENT_R = 2.5; // a grasp/release needs a demonstrated event within this feature distance
  const GOAL_R = 0.8; // release when the inferred drop-off point is reached
  const NEAR = 1.5, FAR = 7.5; // carry: trust demonstrated motion near demos, inferred goal far from them
  const NOISE = 0.08; // robot actuation noise used for fleet runs and evaluation

  function cellKey(cx, cy) { return (cx + 2048) * 4096 + (cy + 2048); }

  // Reach-phase samples store (along, perp) in the goal frame; carry-phase samples store (vx, vy)
  // plus where that demonstrator put the item down (tx, ty).
  function Bucket() {
    this.xs = []; this.ys = []; this.u = []; this.v = []; this.tx = []; this.ty = []; this.g = []; this.w = [];
    this.grid = new Map();
    this.minCx = Infinity; this.maxCx = -Infinity; this.minCy = Infinity; this.maxCy = -Infinity;
  }

  Bucket.prototype.add = function (s, w) {
    const i = this.xs.length;
    this.xs.push(s.x); this.ys.push(s.y); this.u.push(s.u); this.v.push(s.v); this.tx.push(s.tx || 0); this.ty.push(s.ty || 0); this.g.push(s.g); this.w.push(w);
    const cx = Math.floor(s.x / CELL), cy = Math.floor(s.y / CELL);
    const key = cellKey(cx, cy);
    let arr = this.grid.get(key);
    if (!arr) { arr = []; this.grid.set(key, arr); }
    arr.push(i);
    if (cx < this.minCx) this.minCx = cx;
    if (cx > this.maxCx) this.maxCx = cx;
    if (cy < this.minCy) this.minCy = cy;
    if (cy > this.maxCy) this.maxCy = cy;
  };

  Object.defineProperty(Bucket.prototype, 'size', { get: function () { return this.xs.length; } });

  /** Exact k-NN via expanding rings over a uniform grid. Returns [[d2, idx], ...] ascending. */
  Bucket.prototype.knn = function (x, y, k) {
    const best = [];
    const self = this;
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    const maxR = Math.max(Math.abs(cx - this.minCx), Math.abs(cx - this.maxCx), Math.abs(cy - this.minCy), Math.abs(cy - this.maxCy));
    function consider(idx) {
      const dx = self.xs[idx] - x, dy = self.ys[idx] - y;
      const d2 = dx * dx + dy * dy;
      if (best.length < k) best.push([d2, idx]);
      else if (d2 < best[k - 1][0]) best[k - 1] = [d2, idx];
      else return;
      for (let i = best.length - 1; i > 0 && best[i][0] < best[i - 1][0]; i--) {
        const t = best[i]; best[i] = best[i - 1]; best[i - 1] = t;
      }
    }
    function visit(i, j) {
      const arr = self.grid.get(cellKey(i, j));
      if (arr) for (let n = 0; n < arr.length; n++) consider(arr[n]);
    }
    for (let r = 0; r <= maxR; r++) {
      if (r === 0) visit(cx, cy);
      else {
        for (let i = -r; i <= r; i++) { visit(cx + i, cy - r); visit(cx + i, cy + r); }
        for (let j = -r + 1; j <= r - 1; j++) { visit(cx - r, cy + j); visit(cx + r, cy + j); }
      }
      if (best.length >= k) {
        const reach = r * CELL;
        if (reach * reach >= best[best.length - 1][0]) break;
      }
    }
    return best;
  };

  function unit(dx, dy) {
    const d = Math.sqrt(dx * dx + dy * dy);
    return d > 1e-9 ? [dx / d, dy / d, d] : [1, 0, 0];
  }

  /** Turn one demonstration into (features, action) samples with event relabelling. */
  function samplesFromDemo(demo) {
    const end = Sim.replay(demo.init, demo.actions);
    const tx = end.ox, ty = end.oy; // where this demonstrator put the item down
    const out = [];
    Sim.replay(demo.init, demo.actions, function (s, a) {
      const phase = s.held ? 1 : 0;
      let g = a[2];
      if (g === 1) {
        const dx = s.ox - s.gx, dy = s.oy - s.gy;
        if (s.held || dx * dx + dy * dy > Sim.GRASP_R * Sim.GRASP_R) g = 0; // a miss is noise, not intent
      }
      if (g === 2 && !s.held) g = 0;
      if (phase) {
        out.push({ phase: 1, x: s.gx, y: s.gy, u: a[0], v: a[1], tx: tx, ty: ty, g: g });
      } else {
        const goal = unit(s.ox - s.gx, s.oy - s.gy);
        out.push({
          phase: 0, x: goal[2], y: 0, g: g,
          u: a[0] * goal[0] + a[1] * goal[1],
          v: -a[0] * goal[1] + a[1] * goal[0],
        });
      }
    });
    for (let i = 0; i < out.length; i++) {
      if (out[i].g === 1 && out[i].phase === 0) {
        for (let j = 1; j <= SMEAR && i - j >= 0; j++) {
          const p = out[i - j];
          if (p.phase === 0 && p.g === 0 && p.x <= 2 * Sim.GRASP_R) p.g = 1;
        }
      }
    }
    return out;
  }

  function build(demos) {
    const buckets = {};
    const coverage = {};
    let nSamples = 0;
    function bucket(key) { return buckets[key] || (buckets[key] = new Bucket()); }
    for (let d = 0; d < demos.length; d++) {
      const demo = demos[d];
      const w = demo.weight == null ? 1 : demo.weight;
      const type = demo.init.type;
      const samples = samplesFromDemo(demo);
      coverage[type] = (coverage[type] || 0) + 1;
      for (let i = 0; i < samples.length; i++) {
        bucket(type + '|' + samples[i].phase).add(samples[i], w);
        bucket('*|' + samples[i].phase).add(samples[i], w);
        nSamples++;
      }
    }

    function act(s) {
      const phase = s.held ? 1 : 0;
      let b = buckets[s.type + '|' + phase];
      if (!b || b.size < MIN_BUCKET) b = buckets['*|' + phase];
      if (!b || b.size === 0) return [0, 0, 0];
      const toObj = unit(s.ox - s.gx, s.oy - s.gy);
      const nn = phase ? b.knn(s.gx, s.gy, K) : b.knn(toObj[2], 0, K);
      let sw = 0, u = 0, v = 0, sp = 0, tx = 0, ty = 0;
      const votes = [0, 0, 0];
      const nearestEvent = [Infinity, Infinity, Infinity];
      for (let i = 0; i < nn.length; i++) {
        const idx = nn[i][1];
        const d = Math.sqrt(nn[i][0]);
        const w = b.w[idx] / (d + 0.5);
        const g = b.g[idx];
        sw += w; u += w * b.u[idx]; v += w * b.v[idx]; tx += w * b.tx[idx]; ty += w * b.ty[idx];
        sp += w * Math.sqrt(b.u[idx] * b.u[idx] + b.v[idx] * b.v[idx]);
        votes[g] += w * BOOST[g];
        if (d < nearestEvent[g]) nearestEvent[g] = d;
      }
      if (sw <= 0) return [0, 0, 0];
      u /= sw; v /= sw; sp /= sw;
      let g = 0;
      if (phase === 0) {
        if (votes[1] > votes[0] && nearestEvent[1] <= EVENT_R) g = 1;
        return [u * toObj[0] - v * toObj[1], u * toObj[1] + v * toObj[0], g];
      }
      // Carry: follow demonstrated motion where we have coverage; elsewhere head for the
      // drop-off point the demonstrators used, at the speed they used.
      const goal = unit(tx / sw - s.gx, ty / sw - s.gy);
      const d0 = Math.sqrt(nn[0][0]);
      const alpha = Math.max(0, Math.min(1, 1 - (d0 - NEAR) / (FAR - NEAR)));
      if ((votes[2] > votes[0] && nearestEvent[2] <= EVENT_R) || goal[2] <= GOAL_R) g = 2;
      const gs = Math.min(sp, goal[2] * 0.3 + 0.05);
      return [alpha * u + (1 - alpha) * goal[0] * gs, alpha * v + (1 - alpha) * goal[1] * gs, g];
    }

    return { act: act, nDemos: demos.length, nSamples: nSamples, coverage: coverage };
  }

  /** Real actuators are imperfect: per-episode calibration bias plus per-step jitter. */
  function noisyActor(act, rand, level) {
    const lv = level == null ? NOISE : level;
    const bias = 1 + lv * 0.6 * (rand() * 2 - 1);
    return function (s) {
      const a = act(s);
      const k = bias * (1 + lv * (rand() * 2 - 1));
      const j = lv * 0.5 * (rand() * 2 - 1);
      return [a[0] * k - a[1] * j, a[1] * k + a[0] * j, a[2]];
    };
  }

  /** Fixed evaluation suite (common random numbers) so policy versions are comparable. */
  function evalSuite(types, perType, seed) {
    const episodes = [];
    const all = Object.keys(Sim.OBJECTS);
    types.forEach(function (type) {
      const rand = Sim.mulberry32((seed || 777) + all.indexOf(type) * 1013);
      for (let i = 0; i < (perType || 20); i++) episodes.push(Sim.makeEpisode(rand, type));
    });
    return episodes;
  }

  function evaluate(policy, episodes, opts) {
    const byType = {};
    const seed = (opts && opts.seed) || 4242;
    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i];
      const r = byType[ep.type] || (byType[ep.type] = { n: 0, ok: 0, modes: {} });
      const actor = noisyActor(policy.act, Sim.mulberry32(seed + i * 7919), opts && opts.noise);
      const res = Sim.rollout(ep, actor);
      r.n++;
      if (res.state.success) r.ok++;
      else r.modes[res.state.failure] = (r.modes[res.state.failure] || 0) + 1;
    }
    return byType;
  }

  return {
    K: K, MIN_BUCKET: MIN_BUCKET, NOISE: NOISE,
    build: build, evaluate: evaluate, evalSuite: evalSuite, noisyActor: noisyActor, samplesFromDemo: samplesFromDemo,
  };
});
