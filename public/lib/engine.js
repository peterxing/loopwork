/*!
 * LoopWork engine: the platform's business logic (marketplace, QA, pay, training,
 * data dividends, fleet). Pure JS over a JSON state object, shared by the Node
 * server (authoritative, persisted) and the browser (offline demo mode).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./sim.js'), require('./policy.js'));
  else root.LoopEngine = factory(root.LoopSim, root.LoopPolicy);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Sim, Policy) {
  'use strict';

  const SCHEMA = 1;
  const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const HANDOVER_STEPS = 25; // interventions start ~1.25 s before the robot failed
  const EVAL_PER_TYPE = 20;
  const EVAL_SEED = 777;
  const MAX_EVENTS = 400, MAX_FEED = 160, MAX_EPISODES = 400, MAX_OPEN_INTERVENTIONS = 8;
  const MIN_ENGAGED_SEC = 60; // a teleop session (briefing, replay, control, reset) is paid as at least a minute

  const DEFAULT_CONFIG = {
    royaltyRate: 0.1, // share of fleet revenue paid to contributors as data dividends
    teleopBaseCentsPerHour: 2400, // paid for active control time, success or not
    glassesBaseCentsPerHour: 600, // paid for verified footage time
    autoApproveQa: 0.6,
    autoDeploy: true,
    tasksPerRobot: 8,
  };

  const PERSONAS = [
    { id: 'w_you', name: 'You', initials: 'YOU', persona: 'Demo contributor (you)', city: 'Sydney', country: 'Australia', modes: ['teleop', 'glasses'], simulated: false, device: 'Smart glasses + browser teleop', payout: 'Bank account ••42', profile: { precision: 0.85, pace: 0.85, care: 0.92, sortAccuracy: 0.98 }, affinity: [] },
    { id: 'w_kofi', name: 'Kofi Mensah', initials: 'KM', persona: 'Remote teleoperator', city: 'Accra', country: 'Ghana', modes: ['teleop'], simulated: true, device: 'VR headset + haptic gloves', payout: 'Mobile money', profile: { precision: 0.93, pace: 0.9, care: 0.96, sortAccuracy: 0.99 }, affinity: ['handle_glassware', 'stock_shelf'] },
    { id: 'w_priya', name: 'Priya Patel', initials: 'PP', persona: 'Remote teleoperator', city: 'Pune', country: 'India', modes: ['teleop'], simulated: true, device: 'Gamepad + monitor', payout: 'UPI', profile: { precision: 0.86, pace: 0.82, care: 0.9, sortAccuracy: 0.98 }, affinity: ['stock_shelf', 'sort_laundry'] },
    { id: 'w_maria', name: 'Maria Santos', initials: 'MS', persona: 'Hotel housekeeper', city: 'Sydney', country: 'Australia', modes: ['glasses'], simulated: true, device: 'Smart glasses', payout: 'Bank account', profile: { precision: 0.8, pace: 0.85, care: 0.9, sortAccuracy: 0.99 }, affinity: ['sort_laundry'] },
    { id: 'w_tom', name: 'Tom Nguyen', initials: 'TN', persona: 'Kitchen hand', city: 'Melbourne', country: 'Australia', modes: ['glasses'], simulated: true, device: 'Smart glasses', payout: 'Bank account', profile: { precision: 0.78, pace: 0.9, care: 0.85, sortAccuracy: 0.97 }, affinity: ['handle_glassware', 'load_plates'] },
    { id: 'w_aisha', name: 'Aisha Rahman', initials: 'AR', persona: 'Warehouse picker', city: 'Brisbane', country: 'Australia', modes: ['glasses', 'teleop'], simulated: true, device: 'Smart glasses + gamepad', payout: 'Bank account', profile: { precision: 0.82, pace: 0.88, care: 0.88, sortAccuracy: 0.98 }, affinity: ['stock_shelf', 'sort_laundry'] },
    { id: 'w_lucas', name: 'Lucas Oliveira', initials: 'LO', persona: 'Barista', city: 'São Paulo', country: 'Brazil', modes: ['glasses'], simulated: true, device: 'Phone head-mount', payout: 'Pix', profile: { precision: 0.75, pace: 0.85, care: 0.88, sortAccuracy: 0.97 }, affinity: ['handle_glassware'] },
    { id: 'w_hana', name: 'Hana Kim', initials: 'HK', persona: 'Retail stocker, trainee teleoperator', city: 'Auckland', country: 'New Zealand', modes: ['glasses', 'teleop'], simulated: true, device: 'Smart glasses + gamepad', payout: 'Bank account', profile: { precision: 0.72, pace: 0.78, care: 0.85, sortAccuracy: 0.96 }, affinity: ['stock_shelf'] },
  ];

  const SITES = [
    { id: 'harbourside', name: 'Harbourside Hotel', city: 'Sydney', kind: 'Hotel', mix: { towel: 0.55, box: 0.3, glass: 0.15 } },
    { id: 'laneway', name: 'Laneway Bistro', city: 'Melbourne', kind: 'Restaurant', mix: { glass: 0.6, box: 0.25, towel: 0.15 } },
    { id: 'northgate', name: 'Northgate Fulfilment', city: 'Brisbane', kind: 'Warehouse', mix: { box: 0.8, towel: 0.1, glass: 0.1 } },
    { id: 'riverside', name: 'Riverside Aged Care', city: 'Adelaide', kind: 'Aged care', mix: { towel: 0.45, glass: 0.35, box: 0.2 } },
  ];
  const EXPANSION_SITE = { id: 'coastal', name: 'Coastal Kitchen Co.', city: 'Perth', kind: 'Commercial kitchen', mix: { plate: 0.6, glass: 0.25, box: 0.15 } };
  const ROBOT_MODEL = 'Kestrel H1 (simulated humanoid)';

  const LEVELS = [
    { level: 1, name: 'Certified operator', min: 0, mult: 1 },
    { level: 2, name: 'Fleet operator', min: 15, mult: 1.1 },
    { level: 3, name: 'Senior operator', min: 40, mult: 1.25 },
  ];

  class LoopError extends Error {
    constructor(message, status) { super(message); this.name = 'LoopError'; this.status = status || 400; }
  }
  function fail(message, status) { throw new LoopError(message, status); }

  // ---------------------------------------------------------------- helpers
  const clamp = Sim.clamp;
  function r2(v) { return Math.round(v * 100) / 100; }
  function r3(v) { return Math.round(v * 1000) / 1000; }
  function pct(x) { return Math.round((x || 0) * 100) + '%'; }
  function money(c) { return (c < 0 ? '-$' : '$') + (Math.abs(c || 0) / 100).toFixed(2); }
  function fmtSec(s) {
    if (s < 60) return s.toFixed(1) + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's';
    return (s / 3600).toFixed(1) + 'h';
  }

  function rand(state) {
    state.rng = (state.rng + 0x6d2b79f5) >>> 0;
    let t = state.rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function seedFrom(state) { return Math.floor(rand(state) * 4294967296) >>> 0; }
  function subRand(state) { return Sim.mulberry32(seedFrom(state)); }
  function nextId(state, prefix) {
    const n = (state.counters[prefix] || 0) + 1;
    state.counters[prefix] = n;
    return prefix + n;
  }
  function log(state, kind, text, now) {
    state.feed.unshift({ id: nextId(state, 'f'), kind: kind, text: text, at: now, shift: state.shiftNo });
    if (state.feed.length > MAX_FEED) state.feed.length = MAX_FEED;
  }
  function pickWeighted(mix, r) {
    const keys = Object.keys(mix);
    const total = keys.reduce(function (a, k) { return a + mix[k]; }, 0);
    let acc = 0;
    for (let i = 0; i < keys.length; i++) {
      acc += mix[keys[i]] / total;
      if (r < acc) return keys[i];
    }
    return keys[keys.length - 1];
  }
  function getWorker(state, id) {
    const w = state.workers.find(function (x) { return x.id === id; });
    if (!w) fail('Unknown worker: ' + id, 404);
    return w;
  }
  function getSkill(id) {
    if (!Object.prototype.hasOwnProperty.call(Sim.SKILLS, id)) fail('Unknown skill: ' + id);
    return Sim.SKILLS[id];
  }
  function skillOfType(type) { return Sim.SKILL_BY_OBJECT[type]; }
  function siteById(state, id) { return state.sites.find(function (s) { return s.id === id; }); }
  function robotById(state, id) { return state.robots.find(function (r) { return r.id === id; }); }
  function deployedRecord(state) { return state.policies.find(function (p) { return p.version === state.deployedVersion; }) || null; }

  /** Task mix across the fleet, weighted by robots per site. */
  function fleetMix(state) {
    const mix = {};
    let n = 0;
    state.robots.forEach(function (r) {
      const site = siteById(state, r.site);
      Object.keys(site.mix).forEach(function (t) { mix[t] = (mix[t] || 0) + site.mix[t]; });
      n++;
    });
    Object.keys(mix).forEach(function (t) { mix[t] = r3(mix[t] / Math.max(1, n)); });
    return mix;
  }
  function activeTypes(state) {
    const mix = fleetMix(state);
    return Object.keys(Sim.OBJECTS).filter(function (t) { return mix[t] > 0; });
  }
  function activeSkills(state) { return activeTypes(state).map(skillOfType); }
  function qualityMultiplier(qa) { return r2(0.7 + 0.6 * clamp(qa, 0, 1)); }

  // ---------------------------------------------------------------- runtime caches (not persisted)
  function createRuntime() { return { policies: new Map(), suites: new Map() }; }
  function policyFor(state, rt, version) {
    if (rt.policies.has(version)) return rt.policies.get(version);
    const rec = state.policies.find(function (p) { return p.version === version; });
    if (!rec) return null;
    const ids = new Set(rec.demoIds);
    const pol = Policy.build(state.demos.filter(function (d) { return ids.has(d.id); }));
    rt.policies.set(version, pol);
    return pol;
  }
  function suiteFor(rt, types) {
    const key = types.join(',');
    if (!rt.suites.has(key)) rt.suites.set(key, Policy.evalSuite(types, EVAL_PER_TYPE, EVAL_SEED));
    return rt.suites.get(key);
  }

  // ---------------------------------------------------------------- ledger, balances, levels
  function addLedger(state, workerId, kind, cents, ref, memo, status, now) {
    cents = Math.round(cents || 0);
    if (!cents) return null;
    const e = { id: nextId(state, 'l'), worker: workerId, kind: kind, cents: cents, ref: ref || null, memo: memo, status: status, at: now };
    state.ledger.push(e);
    return e;
  }
  function balances(state, workerId) {
    const out = { available: 0, pending: 0, earned: 0, paidOut: 0, byKind: { base: 0, bounty: 0, quality: 0, royalty: 0 } };
    state.ledger.forEach(function (e) {
      if (e.worker !== workerId || e.status === 'void') return;
      if (e.kind === 'payout') { out.paidOut -= e.cents; out.available += e.cents; return; }
      if (e.status === 'pending') { out.pending += e.cents; return; }
      out.available += e.cents;
      out.earned += e.cents;
      out.byKind[e.kind] = (out.byKind[e.kind] || 0) + e.cents;
    });
    return out;
  }
  function teleopLevel(state, workerId) {
    const n = state.demos.filter(function (d) { return d.worker === workerId && d.source === 'teleop' && d.status === 'approved'; }).length;
    let cur = LEVELS[0];
    LEVELS.forEach(function (L) { if (n >= L.min) cur = L; });
    const next = LEVELS.find(function (L) { return L.min > n; }) || null;
    return { level: cur.level, name: cur.name, mult: cur.mult, approved: n, next: next ? { level: next.level, name: next.name, at: next.min } : null };
  }

  // ---------------------------------------------------------------- views (what the API returns)
  function workerView(w) {
    return { id: w.id, name: w.name, initials: w.initials, persona: w.persona, city: w.city, country: w.country, modes: w.modes.slice(), simulated: !!w.simulated, device: w.device, payout: w.payout, joinedAt: w.joinedAt, consent: Object.assign({}, w.consent) };
  }
  function failureVerb(failure, type) {
    const obj = Sim.OBJECTS[type].label.toLowerCase();
    if (failure === 'broke_fragile') return 'broke a ' + obj;
    if (failure === 'wrong_bin') return 'put a ' + obj + ' in the wrong place';
    if (failure === 'dropped') return 'dropped a ' + obj;
    return 'got stuck with a ' + obj;
  }
  function eventView(state, ev) {
    const robot = robotById(state, ev.robot), site = siteById(state, ev.site);
    return {
      id: ev.id, shift: ev.shift, robot: robot ? robot.name : ev.robot, site: site ? site.name : ev.site, city: site ? site.city : '',
      skill: ev.skill, skillName: Sim.SKILLS[ev.skill].name, type: ev.type, failure: ev.failure,
      failureLabel: Sim.FAILURES[ev.failure].label, summary: (robot ? robot.name : ev.robot) + ' ' + failureVerb(ev.failure, ev.type),
      policyVersion: ev.policyVersion, steps: ev.steps, at: ev.at,
    };
  }
  function bountyView(state, b, w) {
    const lvl = w && b.mode === 'teleop' ? teleopLevel(state, w.id) : null;
    return {
      id: b.id, kind: b.kind, mode: b.mode, skill: b.skill, skillName: Sim.SKILLS[b.skill].name, setting: Sim.SKILLS[b.skill].setting,
      title: b.title, reason: b.reason, rateCents: b.rateCents, unit: b.unit, target: b.target, filled: b.filled, status: b.status,
      severity: b.severity, createdShift: b.createdShift, createdAt: b.createdAt, updatedAt: b.updatedAt, closedReason: b.closedReason || null,
      eventId: b.eventId || null, failure: b.failure || null, robot: b.robotName || null, site: b.siteName || null, history: b.history.slice(-12),
      eligible: w ? w.modes.indexOf(b.mode) >= 0 : true,
      effectiveRateCents: lvl ? Math.round(b.rateCents * lvl.mult) : b.rateCents,
    };
  }
  function sessionView(state, s, withDetail) {
    const w = state.workers.find(function (x) { return x.id === s.worker; });
    const b = s.bounty ? state.bounties.find(function (x) { return x.id === s.bounty; }) : null;
    const v = {
      id: s.id, worker: s.worker, workerName: w ? w.name : s.worker, simulated: !!(w && w.simulated), mode: s.mode, kind: s.kind,
      bounty: s.bounty, bountyTitle: b ? b.title : null, skill: s.skill, skillName: Sim.SKILLS[s.skill].name,
      createdAt: s.createdAt, status: s.status, activeSec: s.activeSec, workSec: s.workSec || s.activeSec, qa: s.qa, outcome: s.outcome || null, flags: s.flags || [],
      pay: s.pay, demoIds: s.demoIds, retarget: s.retarget || null, review: s.review || null, event: s.event || null,
    };
    if (s.mode === 'glasses') {
      v.media = Object.assign({}, s.media, { thumbs: withDetail ? s.media.thumbs : undefined });
      v.consent = s.consent; v.workplace = s.workplace || null;
    }
    if (withDetail && s.mode === 'teleop' && s.demoIds.length) {
      const d = state.demos.find(function (x) { return x.id === s.demoIds[0]; });
      if (d) v.demo = { init: d.init, actions: d.actions };
    }
    return v;
  }
  function policyView(p) {
    return {
      version: p.version, createdAt: p.createdAt, nDemos: p.nDemos, nSamples: p.nSamples, contributors: p.contributors,
      excludedOptOut: p.excludedOptOut, bySkill: p.bySkill, overall: p.overall, attribution: p.attribution,
      gate: p.gate, status: p.status, deployedAt: p.deployedAt, trigger: p.trigger, newDemos: p.newDemos,
    };
  }
  function shiftView(s) {
    return {
      id: s.id, no: s.no, policyVersion: s.policyVersion, tasks: s.tasks, ok: s.ok, success: s.tasks ? r3(s.ok / s.tasks) : 0,
      revenueCents: s.revenueCents, damageCents: s.damageCents, dividendCents: s.dividendCents, bySkill: s.bySkill, modes: s.modes, at: s.at,
    };
  }
  // ---------------------------------------------------------------- bounties & dynamic pricing
  function approvedCount(state, skill) {
    return state.demos.filter(function (d) { return d.skill === skill && d.status === 'approved'; }).length;
  }
  function priceTeleop(severity, data) {
    const scarcity = 1 + Math.max(0, 1 - data / 30);
    return Math.round(clamp(8 * (1 + 3 * severity) * scarcity, 8, 80));
  }
  function priceGlassesHourly(severity, data) {
    const scarcity = 1 + 0.5 * Math.max(0, 1 - data / 30);
    return Math.round(clamp(300 * (1 + 2 * severity) * scarcity, 150, 1800));
  }
  function priceIntervention(failure, severity) {
    return Math.round(30 + 60 * severity + (failure === 'broke_fragile' ? 20 : failure === 'dropped' ? 10 : 0));
  }
  function newBounty(state, fields, now) {
    const b = Object.assign({ id: nextId(state, 'b'), filled: 0, status: 'open', createdAt: now, updatedAt: now, createdShift: state.shiftNo, history: [] }, fields);
    b.history.push({ shift: state.shiftNo, rateCents: b.rateCents });
    state.bounties.push(b);
    return b;
  }
  function fillBounty(state, b, amount, now) {
    if (b.status !== 'open') return;
    b.filled = r2(b.filled + amount);
    b.updatedAt = now;
    if (b.filled >= b.target) {
      b.status = 'filled'; b.closedAt = now; b.closedReason = 'Filled';
      log(state, 'bounty', 'Bounty filled: ' + b.title, now);
    }
  }
  const FAILURE_PRIORITY = { broke_fragile: 0, dropped: 1, wrong_bin: 2, timeout: 3 };

  /** After every shift: open, reprice or close bounties based on where the fleet is failing. */
  function updateBounties(state, shift, failures, now) {
    const out = { created: 0, repriced: 0, closed: 0, interventions: 0 };
    activeSkills(state).forEach(function (skillId) {
      const st = shift.bySkill[skillId];
      if (!st || !st.n) return;
      const skill = Sim.SKILLS[skillId];
      const f = 1 - st.ok / st.n;
      const severity = r3(Math.min(1, f * (Sim.OBJECTS[skill.object].fragile ? 1.25 : 1)));
      const data = approvedCount(state, skillId);
      const modes = Object.keys(st.modes).sort(function (a, b) { return st.modes[b] - st.modes[a]; });
      const top = modes[0];
      const open = state.bounties.filter(function (b) { return b.skill === skillId && b.status === 'open'; });
      if (f >= 0.12 && st.n - st.ok >= 2) {
        const reason = pct(f) + ' of "' + skill.name + '" tasks failed in shift ' + shift.no + (top ? ' (mostly: ' + Sim.FAILURES[top].short + ')' : '');
        const need = Math.ceil(6 + 24 * severity);
        let tb = open.find(function (b) { return b.kind === 'skill'; });
        const rate = priceTeleop(severity, data);
        if (!tb) {
          tb = newBounty(state, { kind: 'skill', mode: 'teleop', skill: skillId, unit: 'demo', target: need, rateCents: rate, severity: severity, title: skill.name + ': teleoperated demos', reason: reason }, now);
          out.created++;
          log(state, 'bounty', 'New bounty: ' + tb.title + ' at ' + money(rate) + '/demo', now);
        } else {
          tb.target = Math.max(tb.target, Math.ceil(tb.filled + need / 2));
          tb.rateCents = rate; tb.severity = severity; tb.reason = reason; tb.updatedAt = now;
          tb.history.push({ shift: shift.no, rateCents: rate });
          out.repriced++;
        }
        let gb = open.find(function (b) { return b.kind === 'capture'; });
        const hourly = priceGlassesHourly(severity, data);
        if (!gb) {
          gb = newBounty(state, { kind: 'capture', mode: 'glasses', skill: skillId, unit: 'hour', target: Math.round(60 + 120 * severity), rateCents: hourly, severity: severity, title: skill.name + ': smart-glasses footage', reason: 'Wear glasses while you ' + skill.verb + ' at work (' + skill.setting + '). ' + reason }, now);
          out.created++;
          log(state, 'bounty', 'New bounty: ' + gb.title + ' at +' + money(hourly) + '/hr', now);
        } else {
          gb.rateCents = hourly; gb.severity = severity; gb.updatedAt = now;
          gb.history.push({ shift: shift.no, rateCents: hourly });
          out.repriced++;
        }
      } else if (f < 0.08) {
        const closing = open.filter(function (b) { return b.kind !== 'intervention'; });
        closing.forEach(function (b) {
          b.status = 'closed'; b.closedAt = now; b.closedReason = 'Gap closed: ' + pct(1 - f) + ' fleet success';
          out.closed++;
        });
        if (closing.length) log(state, 'bounty', 'Closed ' + closing.length + ' bounties for "' + skill.name + '": fleet now at ' + pct(1 - f), now);
      }
      // Every residual failure is a takeover opportunity: the most valuable data in the loop.
      const seenRobots = {};
      failures.filter(function (e) { return e.skill === skillId; })
        .sort(function (a, b) { return FAILURE_PRIORITY[a.failure] - FAILURE_PRIORITY[b.failure]; })
        .filter(function (e) { if (seenRobots[e.robot]) return false; seenRobots[e.robot] = true; return true; })
        .slice(0, 2)
        .forEach(function (ev) {
          const openIv = state.bounties.filter(function (b) { return b.kind === 'intervention' && b.status === 'open'; }).length;
          if (openIv >= MAX_OPEN_INTERVENTIONS) return;
          const robot = robotById(state, ev.robot), site = siteById(state, ev.site);
          const ib = newBounty(state, {
            kind: 'intervention', mode: 'teleop', skill: skillId, unit: 'takeover', target: 1, severity: severity,
            rateCents: priceIntervention(ev.failure, Math.max(severity, 0.3)), eventId: ev.id, handover: ev.handover, failure: ev.failure,
            robotName: robot.name, siteName: site.name,
            title: robot.name + ' ' + failureVerb(ev.failure, ev.type) + ' at ' + site.name,
            reason: 'Policy v' + ev.policyVersion + ' failed in shift ' + ev.shift + '. Take over about a second before it went wrong and show it how.',
          }, now);
          ev.bounty = ib.id;
          out.interventions++;
        });
    });
    state.bounties.forEach(function (b) {
      if (b.kind === 'intervention' && b.status === 'open' && state.shiftNo - b.createdShift >= 3) {
        b.status = 'expired'; b.closedAt = now; b.closedReason = 'Expired after 3 shifts';
      }
    });
    return out;
  }

  // ---------------------------------------------------------------- capture pipelines
  function addDemo(state, fields, now) {
    const d = Object.assign({ id: nextId(state, 'd'), createdAt: now }, fields);
    state.demos.push(d);
    return d;
  }

  /** Teleop QA + pay. The server re-simulates the actions; the client's claims are only cross-checked. */
  function recordTeleop(state, w, ep, flat, now, opts) {
    const m = Sim.demoMetrics(ep.init, flat);
    const flags = [];
    const claim = opts.clientOutcome;
    if (claim && (!!claim.success !== m.success || (claim.steps | 0) !== m.steps)) flags.push('replay_mismatch');
    if (!opts.trusted && now - ep.issuedAt < m.steps * (1000 / Sim.HZ) * 0.8) flags.push('faster_than_realtime');
    const cfg = state.config;
    const bounty = ep.bounty ? state.bounties.find(function (b) { return b.id === ep.bounty; }) : null;
    const live = !!(bounty && bounty.status === 'open');
    const status = !m.success ? 'rejected' : (flags.length || m.qa < cfg.autoApproveQa) ? 'review' : 'approved';
    const activeSec = m.steps / Sim.HZ;
    const lvl = teleopLevel(state, w.id);
    const skill = Sim.SKILLS[ep.skill];
    const workSec = Math.max(activeSec, MIN_ENGAGED_SEC);
    const baseCents = Math.max(1, Math.round(cfg.teleopBaseCentsPerHour * workSec / 3600));
    let bountyCents = 0, qualityCents = 0;
    const qm = qualityMultiplier(m.qa);
    if (m.success && live) {
      bountyCents = Math.round(bounty.rateCents * lvl.mult);
      qualityCents = Math.round(bountyCents * (qm - 1));
    }
    const session = {
      id: nextId(state, 's'), worker: w.id, mode: 'teleop', kind: bounty ? bounty.kind : 'practice', bounty: bounty ? bounty.id : null,
      skill: ep.skill, createdAt: now, status: status, activeSec: r2(activeSec), workSec: r2(workSec),
      qa: { score: m.qa, efficiency: m.efficiency, smoothness: m.smoothness, safety: m.safety, idleRatio: m.idleRatio, misses: m.misses, multiplier: qm },
      outcome: { success: m.success, failure: m.failure, steps: m.steps }, flags: flags,
      pay: { baseCents: baseCents, bountyCents: bountyCents, qualityCents: qualityCents, totalCents: baseCents + bountyCents + qualityCents, levelMult: lvl.mult, bountyLive: live },
      demoIds: [], episode: ep.id, event: ep.eventId || null,
    };
    if (m.success) {
      const demo = addDemo(state, {
        worker: w.id, session: session.id, source: 'teleop', skill: ep.skill, type: ep.init.type, init: ep.init,
        actions: flat.slice(0, m.steps * 3), steps: m.steps, quality: m.qa, weight: 1,
        status: status === 'approved' ? 'approved' : 'pending', intervention: !!ep.eventId,
      }, now);
      session.demoIds.push(demo.id);
    }
    const payStatus = status === 'approved' ? 'available' : 'pending';
    addLedger(state, w.id, 'base', baseCents, session.id, 'Teleop session ' + fmtSec(workSec) + ' (' + fmtSec(activeSec) + ' hands-on) · ' + skill.name, 'available', now);
    addLedger(state, w.id, 'bounty', bountyCents, session.id, (bounty ? bounty.title : skill.name) + (lvl.mult > 1 ? ' (L' + lvl.level + ' ×' + lvl.mult + ')' : ''), payStatus, now);
    addLedger(state, w.id, 'quality', qualityCents, session.id, 'Quality multiplier ×' + qm + ' (QA ' + m.qa + ')', payStatus, now);
    if (status === 'approved' && live) fillBounty(state, bounty, 1, now);
    ep.status = 'submitted'; ep.submittedAt = now; ep.session = session.id;
    state.sessions.push(session);
    return { session: session, metrics: m };
  }

  function sanitizeMedia(m) {
    m = m || {};
    const durationSec = clamp(Number(m.durationSec) || 0, 0, 4 * 3600);
    if (durationSec < 5) fail('Clip is too short: at least 5 seconds of footage is needed', 422);
    const thumbs = Array.isArray(m.thumbs) ? m.thumbs.filter(function (t) {
      return typeof t === 'string' && t.length <= 24000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(t);
    }).slice(0, 4) : [];
    return {
      source: ['upload', 'camera', 'simulated'].indexOf(m.source) >= 0 ? m.source : 'simulated',
      durationSec: r2(durationSec),
      width: Math.round(clamp(Number(m.width) || 0, 0, 8192)), height: Math.round(clamp(Number(m.height) || 0, 0, 8192)),
      brightness: r2(clamp(Number(m.brightness) || 0, 0, 255)), sharpness: r2(clamp(Number(m.sharpness) || 0, 0, 100)),
      stability: r2(clamp(Number(m.stability) || 0, 0, 1)), frames: Math.round(clamp(Number(m.frames) || 0, 0, 1000)),
      fileName: typeof m.fileName === 'string' ? m.fileName.replace(/[^\w.\- ()]+/g, '').slice(0, 80) : null,
      thumbs: thumbs,
    };
  }
  function glassesQa(media) {
    const resolution = clamp(Math.min(media.width, media.height) / 720, 0, 1);
    const exposure = clamp(1 - Math.abs(media.brightness - 125) / 100, 0, 1);
    const sharpness = clamp(media.sharpness / 70, 0, 1);
    const stability = clamp(media.stability, 0, 1);
    const coverage = clamp(media.durationSec / 120, 0, 1);
    // Dark or blurry footage is unusable for hand tracking however long it is.
    const gate = Math.min(1, exposure / 0.45) * Math.min(1, sharpness / 0.45);
    const score = (0.2 * resolution + 0.2 * exposure + 0.25 * sharpness + 0.2 * stability + 0.15 * coverage) * gate;
    return { score: r2(score), resolution: r2(resolution), exposure: r2(exposure), sharpness: r2(sharpness), stability: r2(stability), coverage: r2(coverage), multiplier: qualityMultiplier(score) };
  }

  /**
   * Retargeting (SIMULATED in this prototype): in production, hand/object trajectories
   * extracted from egocentric video are retargeted to the robot's embodiment. Here we
   * synthesise them from the contributor's skill profile, degraded by footage quality.
   */
  function retarget(state, w, skillId, qa, durationSec, sessionId, status, now) {
    const type = Sim.SKILLS[skillId].object;
    const target = clamp(Math.round(durationSec / 60 * 0.5 * qa.score + 0.5), 1, 8);
    const base = w.profile || {};
    const prof = { precision: (base.precision || 0.8) * (0.75 + 0.25 * qa.score), pace: base.pace || 0.85, care: (base.care || 0.9) * (0.9 + 0.1 * qa.score), sortAccuracy: base.sortAccuracy || 0.97 };
    const r = subRand(state);
    const demos = [];
    let attempts = 0;
    while (demos.length < target && attempts < target * 3) {
      attempts++;
      const init = Sim.makeEpisode(r, type);
      const res = Sim.rollout(init, Sim.scriptedOperator(init, prof, r));
      if (!res.state.success) continue;
      const flat = Sim.encodeActions(res.actions);
      const m = Sim.demoMetrics(init, flat);
      demos.push(addDemo(state, {
        worker: w.id, session: sessionId, source: 'glasses', skill: skillId, type: type, init: init, actions: flat, steps: m.steps,
        quality: m.qa, weight: r2(0.4 + 0.4 * qa.score), status: status === 'approved' ? 'approved' : 'pending', intervention: false,
      }, now));
    }
    return { attempted: attempts, yielded: demos.length, demos: demos };
  }

  function recordGlasses(state, w, bounty, skillId, media, consent, workplace, now) {
    const qa = glassesQa(media);
    const cfg = state.config;
    const hours = media.durationSec / 3600;
    const skill = Sim.SKILLS[skillId];
    const baseCents = Math.max(1, Math.round(cfg.glassesBaseCentsPerHour * hours));
    let bountyCents = 0, qualityCents = 0;
    if (bounty) {
      bountyCents = Math.round(bounty.rateCents * hours);
      qualityCents = Math.round(bountyCents * (qa.multiplier - 1));
    }
    const status = qa.score >= 0.5 ? 'approved' : 'review';
    const session = {
      id: nextId(state, 's'), worker: w.id, mode: 'glasses', kind: bounty ? 'capture' : 'open', bounty: bounty ? bounty.id : null,
      skill: skillId, createdAt: now, status: status, activeSec: media.durationSec, workSec: media.durationSec, qa: qa, media: media, workplace: workplace || null,
      consent: { siteConsent: true, bystanderNotice: true, privacyZones: true, faceBlur: true, audio: !!consent.audio },
      flags: [], pay: { baseCents: baseCents, bountyCents: bountyCents, qualityCents: qualityCents, totalCents: baseCents + bountyCents + qualityCents }, demoIds: [],
    };
    const rt = retarget(state, w, skillId, qa, media.durationSec, session.id, status, now);
    session.demoIds = rt.demos.map(function (d) { return d.id; });
    session.retarget = { attempted: rt.attempted, yielded: rt.yielded };
    const payStatus = status === 'approved' ? 'available' : 'pending';
    addLedger(state, w.id, 'base', baseCents, session.id, 'Glasses footage ' + fmtSec(media.durationSec) + ' · ' + skill.name, 'available', now);
    addLedger(state, w.id, 'bounty', bountyCents, session.id, bounty ? bounty.title + ' (+' + money(bounty.rateCents) + '/hr)' : '', payStatus, now);
    addLedger(state, w.id, 'quality', qualityCents, session.id, 'Quality multiplier ×' + qa.multiplier + ' (QA ' + qa.score + ')', payStatus, now);
    if (status === 'approved' && bounty) fillBounty(state, bounty, r2(media.durationSec / 60), now);
    state.sessions.push(session);
    return session;
  }

  function settleReview(state, s, approve, note, reviewer, now) {
    s.status = approve ? 'approved' : 'rejected';
    s.review = { decision: approve ? 'approve' : 'reject', note: note || '', by: reviewer || 'Ops reviewer', at: now };
    s.demoIds.forEach(function (id) {
      const d = state.demos.find(function (x) { return x.id === id; });
      if (d) d.status = approve ? 'approved' : 'rejected';
    });
    state.ledger.forEach(function (e) {
      if (e.ref === s.id && e.status === 'pending') e.status = approve ? 'available' : 'void';
    });
    if (approve && s.bounty) {
      const b = state.bounties.find(function (x) { return x.id === s.bounty; });
      if (b) fillBounty(state, b, s.mode === 'glasses' ? r2(s.activeSec / 60) : 1, now);
    }
  }

  // ---------------------------------------------------------------- training, valuation, deployment
  function successOf(byType, type) { const e = byType[type]; return e && e.n ? e.ok / e.n : 0; }

  /** Weighted overall success on a set of skills using the current fleet task mix. */
  function weightedOverall(state, bySkill, skills) {
    const mix = fleetMix(state);
    let num = 0, den = 0;
    skills.forEach(function (sk) {
      const m = mix[Sim.SKILLS[sk].object] || 0;
      if (bySkill[sk]) { num += m * bySkill[sk].success; den += m; }
    });
    return den ? r3(num / den) : 0;
  }

  /**
   * Train -> evaluate -> attribute -> gate -> (deploy).
   * Attribution blends each contributor's data volume with their leave-one-out
   * marginal contribution to evaluated success, per skill, weighted by the revenue
   * that skill generates. This share drives ongoing data-dividend payments.
   */
  function train(state, rt, args, now) {
    const opted = new Set(state.workers.filter(function (w) { return w.consent && w.consent.dataOptOut; }).map(function (w) { return w.id; }));
    const approved = state.demos.filter(function (d) { return d.status === 'approved'; });
    const demos = approved.filter(function (d) { return !opted.has(d.worker); });
    if (!demos.length) fail('No approved demonstrations to train on yet', 409);
    const prev = deployedRecord(state);
    const latest = state.policies[state.policies.length - 1];
    if (latest && !args.force) {
      const ids = new Set(latest.demoIds);
      if (ids.size === demos.length && demos.every(function (d) { return ids.has(d.id); })) {
        fail('No new approved data since policy v' + latest.version + ' (capture some demos first)', 409);
      }
    }
    const prevIds = new Set(latest ? latest.demoIds : []);
    const types = activeTypes(state);
    const suite = suiteFor(rt, types);
    const pol = Policy.build(demos);
    const ev = Policy.evaluate(pol, suite);
    const bySkill = {};
    types.forEach(function (t) {
      const e = ev[t] || { n: 0, ok: 0, modes: {} };
      bySkill[skillOfType(t)] = { success: e.n ? r3(e.ok / e.n) : 0, n: e.n, modes: e.modes };
    });
    const skills = Object.keys(bySkill);
    const overall = weightedOverall(state, bySkill, skills);

    // data valuation
    const contrib = {};
    demos.forEach(function (d) {
      const c = contrib[d.worker] || (contrib[d.worker] = {});
      const x = c[d.type] || (c[d.type] = { w: 0, n: 0, iv: 0 });
      x.w += (d.weight == null ? 1 : d.weight) * (0.5 + 0.5 * (d.quality || 0.5)) * d.steps;
      x.n++;
      if (d.intervention) x.iv++;
    });
    const marginal = {};
    Object.keys(contrib).forEach(function (wid) {
      const mine = Object.keys(contrib[wid]).filter(function (t) { return types.indexOf(t) >= 0; });
      if (!mine.length) return;
      const without = Policy.build(demos.filter(function (d) { return d.worker !== wid; }));
      const evc = Policy.evaluate(without, suite.filter(function (e) { return mine.indexOf(e.type) >= 0; }));
      marginal[wid] = {};
      mine.forEach(function (t) { marginal[wid][t] = Math.max(0, successOf(ev, t) - successOf(evc, t)); });
    });
    const mix = fleetMix(state);
    const value = {};
    let totalValue = 0;
    types.forEach(function (t) {
      value[t] = (mix[t] || 0) * Sim.SKILLS[skillOfType(t)].revenueCents * successOf(ev, t);
      totalValue += value[t];
    });
    const shares = {}, skillShares = {}, skillMarginal = {};
    types.forEach(function (t) {
      const cs = Object.keys(contrib).filter(function (wid) { return contrib[wid][t]; });
      if (!cs.length || !value[t] || !totalValue) return;
      const W = cs.reduce(function (a, wid) { return a + contrib[wid][t].w; }, 0);
      const M = cs.reduce(function (a, wid) { return a + ((marginal[wid] && marginal[wid][t]) || 0); }, 0);
      cs.forEach(function (wid) {
        const vol = contrib[wid][t].w / W;
        const mar = M > 0 ? ((marginal[wid] && marginal[wid][t]) || 0) / M : vol;
        const s = 0.5 * vol + 0.5 * mar;
        const sk = skillOfType(t);
        (skillShares[wid] = skillShares[wid] || {})[sk] = r3(s);
        (skillMarginal[wid] = skillMarginal[wid] || {})[sk] = r3((marginal[wid] && marginal[wid][t]) || 0);
        shares[wid] = (shares[wid] || 0) + s * value[t] / totalValue;
      });
    });
    const attribution = Object.keys(shares).map(function (wid) {
      const c = contrib[wid];
      return {
        worker: wid, share: r3(shares[wid]), bySkill: skillShares[wid] || {}, marginal: skillMarginal[wid] || {},
        demos: Object.keys(c).reduce(function (a, t) { return a + c[t].n; }, 0),
        interventions: Object.keys(c).reduce(function (a, t) { return a + c[t].iv; }, 0),
      };
    }).sort(function (a, b) { return b.share - a.share; });

    // safety gate: no skill may regress by more than 10 points, overall by more than 2
    const reasons = [];
    if (prev) {
      const common = skills.filter(function (sk) { return prev.bySkill[sk]; });
      common.forEach(function (sk) {
        if (bySkill[sk].success < prev.bySkill[sk].success - 0.1) reasons.push(Sim.SKILLS[sk].name + ' regressed ' + pct(prev.bySkill[sk].success) + ' → ' + pct(bySkill[sk].success));
      });
      const oNew = weightedOverall(state, bySkill, common), oOld = weightedOverall(state, prev.bySkill, common);
      if (oNew < oOld - 0.02) reasons.push('Overall success fell ' + pct(oOld) + ' → ' + pct(oNew));
    }
    const version = state.policies.reduce(function (m, p) { return Math.max(m, p.version); }, 0) + 1;
    const rec = {
      version: version, createdAt: now, demoIds: demos.map(function (d) { return d.id; }), nDemos: demos.length, nSamples: pol.nSamples,
      newDemos: demos.filter(function (d) { return !prevIds.has(d.id); }).length,
      contributors: Object.keys(contrib).length, excludedOptOut: approved.length - demos.length, bySkill: bySkill, overall: overall,
      attribution: attribution, gate: { passed: reasons.length === 0, reasons: reasons, comparedTo: prev ? prev.version : null },
      status: 'candidate', deployedAt: null, trigger: args.trigger || 'manual',
    };
    state.policies.push(rec);
    rt.policies.set(version, pol);
    log(state, 'train', 'Trained policy v' + version + ' on ' + demos.length + ' demos from ' + rec.contributors + ' contributors: ' + pct(overall) + ' eval success', now);
    const auto = args.autoDeploy != null ? !!args.autoDeploy : state.config.autoDeploy;
    if (!rec.gate.passed) {
      rec.status = 'blocked';
      log(state, 'deploy', 'Safety gate blocked v' + version + ': ' + reasons.join('; '), now);
    } else if (auto) {
      deployVersion(state, version, now, false);
    }
    return rec;
  }

  function deployVersion(state, version, now, manual) {
    const rec = state.policies.find(function (p) { return p.version === version; });
    if (!rec) fail('Unknown policy version: ' + version, 404);
    if (rec.status === 'deployed') fail('Policy v' + version + ' is already deployed', 409);
    const wasBlocked = rec.status === 'blocked';
    state.policies.forEach(function (p) { if (p.status === 'deployed') p.status = 'retired'; });
    rec.status = 'deployed'; rec.deployedAt = now;
    state.deployedVersion = version;
    state.robots.forEach(function (r) { r.policyVersion = version; });
    log(state, 'deploy', (manual ? 'Manually deployed' : 'Deployed') + ' policy v' + version + ' to ' + state.robots.length + ' humanoids' + (wasBlocked ? ' (safety-gate override)' : ''), now);
    return rec;
  }

  // ---------------------------------------------------------------- the fleet
  function runShift(state, rt, args, now) {
    const version = state.deployedVersion;
    const pol = version ? policyFor(state, rt, version) : null;
    if (!pol) fail('No policy is deployed yet: train one first', 409);
    state.shiftNo += 1;
    const no = state.shiftNo;
    const shift = { id: nextId(state, 'sh'), no: no, policyVersion: version, tasks: 0, ok: 0, revenueCents: 0, damageCents: 0, bySkill: {}, modes: {}, dividendCents: 0, at: now };
    const failures = [];
    state.robots.forEach(function (robot) {
      const site = siteById(state, robot.site);
      let rOk = 0, rN = 0, last = 'ok';
      for (let i = 0; i < state.config.tasksPerRobot; i++) {
        const type = pickWeighted(site.mix, rand(state));
        const skill = skillOfType(type);
        const init = Sim.makeEpisode(subRand(state), type);
        const noiseSeed = seedFrom(state);
        const res = Sim.rollout(init, Policy.noisyActor(pol.act, Sim.mulberry32(noiseSeed)), { frames: true });
        const st = shift.bySkill[skill] || (shift.bySkill[skill] = { n: 0, ok: 0, modes: {} });
        st.n++; shift.tasks++; rN++;
        if (res.state.success) {
          st.ok++; shift.ok++; rOk++; last = 'ok';
          shift.revenueCents += Sim.SKILLS[skill].revenueCents;
        } else {
          const f = res.state.failure;
          st.modes[f] = (st.modes[f] || 0) + 1;
          shift.modes[f] = (shift.modes[f] || 0) + 1;
          shift.damageCents += Sim.FAILURES[f].damageCents;
          last = f;
          const k = Math.max(0, res.frames.length - 1 - HANDOVER_STEPS);
          const fr = res.frames[k];
          const handover = { type: type, gx: fr[0], gy: fr[1], ox: fr[2], oy: fr[3] };
          if (fr[4]) handover.held = true;
          const ev = { id: nextId(state, 'ev'), shift: no, robot: robot.id, site: site.id, skill: skill, type: type, init: init, handover: handover, handoverStep: k, noiseSeed: noiseSeed, failure: f, steps: res.state.t, policyVersion: version, at: now };
          state.events.push(ev);
          failures.push(ev);
        }
      }
      robot.tasks += rN; robot.ok += rOk; robot.lastShift = { tasks: rN, ok: rOk };
      robot.status = last === 'ok' ? 'autonomous' : 'needs_help';
      robot.lastOutcome = last; robot.policyVersion = version;
    });
    if (state.events.length > MAX_EVENTS) {
      const keep = new Set(state.bounties.filter(function (b) { return b.status === 'open' && b.eventId; }).map(function (b) { return b.eventId; }));
      const overflow = state.events.length - MAX_EVENTS;
      let removed = 0;
      state.events = state.events.filter(function (e) {
        if (removed < overflow && !keep.has(e.id)) { removed++; return false; }
        return true;
      });
    }
    // data dividends: a share of this shift's revenue flows to the people whose data the live model uses
    const pool = Math.floor(shift.revenueCents * state.config.royaltyRate);
    const rec = deployedRecord(state);
    let paid = 0, payees = 0;
    if (pool > 0 && rec && rec.attribution.length) {
      rec.attribution.forEach(function (a) {
        const c = Math.floor(pool * a.share);
        if (c > 0) {
          addLedger(state, a.worker, 'royalty', c, shift.id, 'Data dividend · shift ' + no + ' · policy v' + version + ' (' + (a.share * 100).toFixed(1) + '% share)', 'available', now);
          paid += c; payees++;
        }
      });
    }
    shift.dividendCents = paid;
    state.shifts.push(shift);
    const priced = updateBounties(state, shift, failures, now);
    log(state, 'fleet', 'Shift ' + no + ': ' + shift.ok + '/' + shift.tasks + ' tasks succeeded (' + pct(shift.ok / shift.tasks) + ') on policy v' + version + ', ' + failures.length + ' failures', now);
    if (paid) log(state, 'dividend', 'Paid ' + money(paid) + ' in data dividends to ' + payees + ' contributors', now);
    return { shift: shift, failures: failures, priced: priced };
  }

  // ---------------------------------------------------------------- simulated contributors (demo realism)
  function simTeleop(state, w, bounty, skillId, now) {
    const type = Sim.SKILLS[skillId].object;
    const init = bounty && bounty.kind === 'intervention' ? Object.assign({}, bounty.handover) : Sim.makeEpisode(subRand(state), type);
    const ep = { id: nextId(state, 'ep'), worker: w.id, bounty: bounty ? bounty.id : null, skill: skillId, init: init, eventId: bounty && bounty.eventId ? bounty.eventId : null, issuedAt: now - HOUR, status: 'issued' };
    state.episodes.push(ep);
    const r = subRand(state);
    const res = Sim.rollout(init, Sim.scriptedOperator(init, w.profile, r));
    return recordTeleop(state, w, ep, Sim.encodeActions(res.actions), now, { trusted: true }).session;
  }
  function simGlasses(state, w, bounty, now) {
    const minutes = 4 + Math.floor(rand(state) * 16);
    const phone = /phone/i.test(w.device || '');
    const media = {
      source: 'simulated', durationSec: minutes * 60, width: phone ? 1280 : 1920, height: phone ? 720 : 1080,
      brightness: r2(95 + rand(state) * 60), sharpness: r2(48 + rand(state) * 45), stability: r2(0.55 + rand(state) * 0.4),
      frames: 0, fileName: null, thumbs: [],
    };
    return recordGlasses(state, w, bounty, bounty.skill, media, { audio: false }, null, now);
  }
  function affinityScore(w, b) { return b.rateCents * (w.affinity && w.affinity.indexOf(b.skill) >= 0 ? 1.6 : 1); }

  function simulateWorkers(state, now) {
    const out = { sessions: [], teleopDemos: 0, interventions: 0, glassesMinutes: 0 };
    function open(kind) { return state.bounties.filter(function (b) { return b.status === 'open' && b.kind === kind; }); }
    state.workers.filter(function (w) { return w.simulated; }).forEach(function (w) {
      if (rand(state) > 0.7) return; // not everyone works every shift
      if (w.modes.indexOf('teleop') >= 0) {
        let budget = 1 + Math.floor(rand(state) * 3);
        open('intervention').sort(function (a, b) { return b.rateCents - a.rateCents; }).forEach(function (b) {
          if (budget <= 0 || b.status !== 'open' || rand(state) < 0.45) return;
          const s = simTeleop(state, w, b, b.skill, now);
          out.sessions.push(s); budget--;
          if (s.outcome.success) { out.teleopDemos++; out.interventions++; }
        });
        const skillB = open('skill').sort(function (a, b) { return affinityScore(w, b) - affinityScore(w, a); })[0];
        while (skillB && budget > 0 && skillB.status === 'open') {
          const s = simTeleop(state, w, skillB, skillB.skill, now);
          out.sessions.push(s); budget--;
          if (s.outcome.success) out.teleopDemos++;
        }
      }
      if (w.modes.indexOf('glasses') >= 0 && rand(state) < 0.6) {
        const capB = open('capture').sort(function (a, b) { return affinityScore(w, b) - affinityScore(w, a); })[0];
        if (capB) {
          const s = simGlasses(state, w, capB, now);
          out.sessions.push(s);
          out.glassesMinutes += s.activeSec / 60;
        }
      }
    });
    return out;
  }

  /** Simulated reviewers clear simulated contributors' review items. Your own items wait for you in Ops. */
  function autoReviewSimulated(state, now) {
    const out = { approved: 0, rejected: 0 };
    state.sessions.forEach(function (s) {
      if (s.status !== 'review') return;
      const w = state.workers.find(function (x) { return x.id === s.worker; });
      if (!w || !w.simulated) return;
      const ok = (s.qa.score || 0) >= 0.45 && (s.flags || []).length === 0;
      settleReview(state, s, ok, ok ? 'Spot-checked by QA crew' : 'Below quality bar', 'QA crew (simulated)', now);
      if (ok) out.approved++; else out.rejected++;
    });
    return out;
  }

  function openBountyValue(state) {
    return state.bounties.filter(function (b) { return b.status === 'open'; }).reduce(function (a, b) {
      const left = Math.max(0, b.target - b.filled);
      if (b.unit === 'hour') return a + Math.round(b.rateCents * left / 60);
      return a + b.rateCents * (b.unit === 'takeover' ? 1 : left);
    }, 0);
  }

  function buildStages(state, info) {
    const shift = info.shift;
    const failures = shift.tasks - shift.ok;
    const topMode = Object.keys(shift.modes).sort(function (a, b) { return shift.modes[b] - shift.modes[a]; })[0];
    const openB = state.bounties.filter(function (b) { return b.status === 'open'; });
    const p = info.trained;
    return [
      { key: 'capture', label: 'Workers capture', value: info.sessions + ' sessions', sub: info.teleopDemos + ' teleop demos · ' + Math.round(info.glassesMinutes) + ' min glasses' },
      { key: 'verify', label: 'Verify & QA', value: info.approved + ' approved', sub: info.review + ' in review · ' + info.rejected + ' rejected' },
      { key: 'train', label: 'Train & evaluate', value: p ? 'v' + p.version + ' · ' + pct(p.overall) : 'no new data', sub: p ? p.nDemos + ' demos · ' + p.contributors + ' contributors' : 'kept v' + state.deployedVersion },
      { key: 'deploy', label: 'Gate & deploy', value: p ? (p.status === 'deployed' ? 'v' + p.version + ' live' : 'v' + p.version + ' blocked') : 'v' + state.deployedVersion + ' live', sub: p && p.gate.reasons.length ? p.gate.reasons[0] : 'no regressions' },
      { key: 'fleet', label: 'Fleet works', value: shift.ok + '/' + shift.tasks + ' tasks', sub: pct(shift.ok / Math.max(1, shift.tasks)) + ' success · ' + money(shift.revenueCents) + ' revenue' },
      { key: 'detect', label: 'Failures detected', value: failures + ' failures', sub: topMode ? 'mostly ' + Sim.FAILURES[topMode].short + ' · ' + money(shift.damageCents) + ' damage' : 'clean shift' },
      { key: 'price', label: 'Bounties priced', value: openB.length + ' open', sub: money(openBountyValue(state)) + ' on offer' },
      { key: 'pay', label: 'Workers paid', value: money(info.paidCents + shift.dividendCents), sub: money(shift.dividendCents) + ' in data dividends' },
    ];
  }

  function runCycle(state, rt, args, now) {
    const before = deployedRecord(state);
    const ledgerStart = state.ledger.length;
    const work = simulateWorkers(state, now);
    autoReviewSimulated(state, now);
    let trained = null;
    try { trained = train(state, rt, { trigger: 'loop' }, now); } catch (e) { if (!(e instanceof LoopError) || e.status !== 409) throw e; }
    const res = runShift(state, rt, {}, now);
    state.cycleNo += 1;
    const sessionIds = new Set(work.sessions.map(function (s) { return s.id; }));
    const mine = state.sessions.filter(function (s) { return sessionIds.has(s.id); });
    const paidCents = state.ledger.slice(ledgerStart).filter(function (e) {
      return e.kind !== 'payout' && e.kind !== 'royalty' && e.status !== 'void';
    }).reduce(function (a, e) { return a + e.cents; }, 0);
    const after = deployedRecord(state);
    state.lastCycle = {
      no: state.cycleNo, at: now,
      before: before ? { version: before.version, overall: before.overall } : null,
      after: after ? { version: after.version, overall: after.overall } : null,
      stages: buildStages(state, {
        shift: res.shift, trained: trained, sessions: work.sessions.length, teleopDemos: work.teleopDemos, glassesMinutes: work.glassesMinutes,
        approved: mine.filter(function (s) { return s.status === 'approved'; }).length,
        review: mine.filter(function (s) { return s.status === 'review'; }).length,
        rejected: mine.filter(function (s) { return s.status === 'rejected'; }).length,
        paidCents: paidCents,
      }),
    };
    log(state, 'loop', 'Loop cycle ' + state.cycleNo + ' complete: fleet ' + pct(res.shift.ok / res.shift.tasks) + ' on v' + state.deployedVersion, now);
    return { cycle: state.lastCycle, trained: trained ? policyView(trained) : null, shift: shiftView(res.shift), failures: res.failures.length, priced: res.priced, interventionsSolved: work.interventions };
  }

  // ---------------------------------------------------------------- state
  function addSite(state, s, at) {
    const site = JSON.parse(JSON.stringify(s));
    site.joinedAt = at;
    site.agreement = 'Site recording agreement signed';
    state.sites.push(site);
    for (let i = 0; i < 3; i++) {
      const n = state.robots.length + 1;
      state.robots.push({ id: 'r' + n, name: 'Unit-' + String(n).padStart(2, '0'), model: ROBOT_MODEL, site: site.id, status: 'autonomous', tasks: 0, ok: 0, lastShift: null, lastOutcome: null, policyVersion: state.deployedVersion });
    }
    return site;
  }

  function createState(opts) {
    opts = opts || {};
    const now = opts.now || Date.now();
    const seed = (opts.seed == null ? 20261018 : Number(opts.seed)) >>> 0;
    const state = {
      schema: SCHEMA, seed: seed, rng: seed, createdAt: now, shiftNo: 0, cycleNo: 0, deployedVersion: 0,
      config: Object.assign({}, DEFAULT_CONFIG), counters: {}, workers: [], sites: [], robots: [], bounties: [], episodes: [],
      sessions: [], demos: [], policies: [], shifts: [], events: [], ledger: [], feed: [], lastCycle: null,
    };
    PERSONAS.forEach(function (p, i) {
      state.workers.push(Object.assign(JSON.parse(JSON.stringify(p)), {
        joinedAt: now - (60 - i * 5) * DAY,
        consent: { faceBlur: true, privacyZones: true, audio: false, openResearch: i % 3 === 1, dataOptOut: false },
      }));
    });
    SITES.forEach(function (s) { addSite(state, s, now - 30 * DAY); });
    seedHistory(state, now);
    return state;
  }

  /** A short pilot: a few box demos, policy v1, one fleet shift that exposes the gaps. */
  function seedHistory(state, now) {
    const rt = createRuntime();
    const t0 = now - 2 * DAY;
    log(state, 'system', 'Pilot started: 12 humanoids across 4 sites, first contributors onboarded', t0);
    const kofi = getWorker(state, 'w_kofi'), priya = getWorker(state, 'w_priya'), aisha = getWorker(state, 'w_aisha');
    const sessions = [];
    for (let i = 0; i < 6; i++) sessions.push(simTeleop(state, kofi, null, 'stock_shelf', t0 + (i + 1) * 4 * MIN));
    for (let i = 0; i < 5; i++) sessions.push(simTeleop(state, priya, null, 'stock_shelf', t0 + (i + 1) * 5 * MIN));
    sessions.push(simTeleop(state, aisha, null, 'sort_laundry', t0 + 30 * MIN));
    const v1 = train(state, rt, { trigger: 'pilot' }, t0 + 2 * HOUR);
    const res = runShift(state, rt, {}, t0 + 6 * HOUR);
    const paid = state.ledger.filter(function (e) { return e.kind !== 'royalty' && e.kind !== 'payout' && e.status !== 'void'; }).reduce(function (a, e) { return a + e.cents; }, 0);
    state.lastCycle = {
      no: 0, at: t0 + 6 * HOUR, before: null, after: { version: v1.version, overall: v1.overall },
      stages: buildStages(state, {
        shift: res.shift, trained: v1, sessions: sessions.length,
        teleopDemos: sessions.filter(function (s) { return s.outcome.success; }).length, glassesMinutes: 0,
        approved: sessions.filter(function (s) { return s.status === 'approved'; }).length,
        review: sessions.filter(function (s) { return s.status === 'review'; }).length,
        rejected: sessions.filter(function (s) { return s.status === 'rejected'; }).length,
        paidCents: paid,
      }),
    };
  }

  // ---------------------------------------------------------------- API operations
  function named(state, attribution) {
    return (attribution || []).map(function (a) {
      const w = state.workers.find(function (x) { return x.id === a.worker; });
      return Object.assign({}, a, { name: w ? w.name : a.worker, simulated: !!(w && w.simulated) });
    });
  }
  function policyFull(state, p) { const v = policyView(p); v.attribution = named(state, p.attribution); return v; }

  function opOverview(box) {
    const state = box.state;
    const dep = deployedRecord(state);
    const last = state.shifts[state.shifts.length - 1] || null;
    const totals = { earned: 0, royalty: 0, pending: 0, paidOut: 0, work: 0 };
    const earnings = state.workers.map(function (w) {
      const b = balances(state, w.id);
      totals.earned += b.earned; totals.royalty += b.byKind.royalty; totals.pending += b.pending; totals.paidOut += b.paidOut;
      totals.work += b.byKind.base + b.byKind.bounty + b.byKind.quality;
      return { id: w.id, name: w.name, initials: w.initials, persona: w.persona, simulated: !!w.simulated, byKind: b.byKind, earned: b.earned, pending: b.pending };
    }).sort(function (a, b) { return b.earned - a.earned; });
    const secs = state.sessions.reduce(function (a, s) { return a + (s.status === 'rejected' && s.mode === 'glasses' ? 0 : s.workSec || s.activeSec || 0); }, 0);
    const openB = state.bounties.filter(function (b) { return b.status === 'open'; });
    const skills = activeSkills(state).map(function (sk) {
      const st = last && last.bySkill[sk];
      const top = st ? Object.keys(st.modes).sort(function (a, b) { return st.modes[b] - st.modes[a]; })[0] : null;
      return {
        id: sk, name: Sim.SKILLS[sk].name, object: Sim.SKILLS[sk].object, setting: Sim.SKILLS[sk].setting,
        evalSuccess: dep && dep.bySkill[sk] ? dep.bySkill[sk].success : null,
        fleetSuccess: st && st.n ? r3(st.ok / st.n) : null, tasks: st ? st.n : 0,
        topFailure: top ? Sim.FAILURES[top].label : null,
        openBounties: openB.filter(function (b) { return b.skill === sk; }).length, demos: approvedCount(state, sk),
      };
    });
    return {
      shiftNo: state.shiftNo, cycleNo: state.cycleNo, config: state.config, mix: fleetMix(state),
      deployed: dep ? policyFull(state, dep) : null,
      kpis: {
        evalSuccess: dep ? dep.overall : 0, fleetSuccess: last ? r3(last.ok / last.tasks) : 0,
        revenueCents: last ? last.revenueCents : 0, damageCents: last ? last.damageCents : 0,
        earnedCents: totals.earned, royaltiesCents: totals.royalty, pendingCents: totals.pending, paidOutCents: totals.paidOut,
        openBounties: openB.length, openValueCents: openBountyValue(state),
        contributors: new Set(state.demos.filter(function (d) { return d.status === 'approved'; }).map(function (d) { return d.worker; })).size,
        demos: state.demos.filter(function (d) { return d.status === 'approved'; }).length,
        robots: state.robots.length, sites: state.sites.length,
        effectiveHourlyCents: secs > 0 ? Math.round(totals.work / (secs / 3600)) : 0,
      },
      versions: state.policies.map(function (p) {
        const by = {};
        Object.keys(p.bySkill).forEach(function (sk) { by[sk] = p.bySkill[sk].success; });
        return { version: p.version, overall: p.overall, bySkill: by, status: p.status, createdAt: p.createdAt };
      }),
      shifts: state.shifts.slice(-30).map(shiftView),
      earnings: earnings, skills: skills, lastCycle: state.lastCycle, feed: state.feed.slice(0, 40),
      workers: state.workers.map(workerView),
    };
  }

  function opWorkerDetail(box, args) {
    const state = box.state;
    const w = getWorker(state, args.workerId);
    const bal = balances(state, w.id);
    const dep = deployedRecord(state);
    const depIds = new Set(dep ? dep.demoIds : []);
    const mine = state.demos.filter(function (d) { return d.worker === w.id; });
    const bySkill = {};
    mine.forEach(function (d) {
      const x = bySkill[d.skill] || (bySkill[d.skill] = { skillName: Sim.SKILLS[d.skill].name, approved: 0, pending: 0, rejected: 0, interventions: 0, inModel: 0, teleop: 0, glasses: 0 });
      x[d.status] = (x[d.status] || 0) + 1;
      if (d.intervention && d.status === 'approved') x.interventions++;
      if (depIds.has(d.id)) x.inModel++;
      if (d.source === 'glasses') x.glasses++; else x.teleop++;
    });
    const attr = dep ? dep.attribution.find(function (a) { return a.worker === w.id; }) : null;
    const royalties = state.shifts.slice(-12).map(function (sh) {
      const cents = state.ledger.filter(function (e) { return e.worker === w.id && e.kind === 'royalty' && e.ref === sh.id; }).reduce(function (a, e) { return a + e.cents; }, 0);
      return { shift: sh.no, cents: cents, version: sh.policyVersion };
    });
    const sessions = state.sessions.filter(function (s) { return s.worker === w.id; });
    const secs = sessions.reduce(function (a, s) { return a + (s.workSec || s.activeSec || 0); }, 0);
    const work = bal.byKind.base + bal.byKind.bounty + bal.byKind.quality;
    return {
      worker: workerView(w), balances: bal, level: teleopLevel(state, w.id),
      sessions: sessions.slice(-40).reverse().map(function (s) { return sessionView(state, s, false); }),
      demos: bySkill, activeHours: r2(secs / 3600), effectiveHourlyCents: secs > 0 ? Math.round(work / (secs / 3600)) : 0,
      deployed: dep ? { version: dep.version, share: attr ? attr.share : 0, bySkill: attr ? attr.bySkill : {}, marginal: attr ? attr.marginal : {}, inModel: mine.filter(function (d) { return depIds.has(d.id); }).length } : null,
      royalties: royalties,
      ledger: state.ledger.filter(function (e) { return e.worker === w.id; }).slice(-30).reverse(),
      bounties: opBounties(box, { workerId: w.id }).bounties,
    };
  }

  function opBounties(box, args) {
    const state = box.state;
    const w = args.workerId ? getWorker(state, args.workerId) : null;
    const kindRank = { intervention: 0, skill: 1, capture: 2 };
    const list = state.bounties.filter(function (b) { return b.status === 'open'; })
      .sort(function (a, b) { return kindRank[a.kind] - kindRank[b.kind] || b.rateCents - a.rateCents; })
      .map(function (b) { return bountyView(state, b, w); });
    const recent = state.bounties.filter(function (b) { return b.status !== 'open'; }).slice(-12).reverse().map(function (b) { return bountyView(state, b, w); });
    return { bounties: list, recentlyClosed: recent };
  }

  function opIssueEpisode(box, args, now) {
    const state = box.state;
    const w = getWorker(state, args.workerId);
    if (w.modes.indexOf('teleop') < 0) fail(w.name + ' is not enrolled for teleoperation', 403);
    let bounty = null, skill = null, init = null, ev = null;
    if (args.bountyId) {
      bounty = state.bounties.find(function (b) { return b.id === args.bountyId; });
      if (!bounty) fail('Bounty not found', 404);
      if (bounty.status !== 'open') fail('That bounty is no longer open', 409);
      if (bounty.mode !== 'teleop') fail('That bounty needs smart-glasses footage, not teleoperation');
      skill = bounty.skill;
      if (bounty.kind === 'intervention') {
        ev = state.events.find(function (e) { return e.id === bounty.eventId; }) || null;
        init = Object.assign({}, bounty.handover);
      }
    } else {
      skill = args.skill || activeSkills(state)[0];
      getSkill(skill);
    }
    if (!init) init = Sim.makeEpisode(subRand(state), Sim.SKILLS[skill].object);
    const outstanding = state.episodes.filter(function (e) { return e.worker === w.id && e.status === 'issued'; });
    for (let i = 0; i < outstanding.length - 4; i++) outstanding[i].status = 'expired';
    const ep = { id: nextId(state, 'ep'), worker: w.id, bounty: bounty ? bounty.id : null, skill: skill, init: init, eventId: ev ? ev.id : null, issuedAt: now, status: 'issued' };
    state.episodes.push(ep);
    if (state.episodes.length > MAX_EPISODES) state.episodes.splice(0, state.episodes.length - MAX_EPISODES);
    return {
      episode: { id: ep.id, skill: skill, skillName: Sim.SKILLS[skill].name, init: init, issuedAt: now },
      bounty: bounty ? bountyView(state, bounty, w) : null, event: ev ? eventView(state, ev) : null,
      level: teleopLevel(state, w.id), baseCentsPerHour: state.config.teleopBaseCentsPerHour,
    };
  }

  function opSubmitEpisode(box, args, now, ctx) {
    const state = box.state;
    const ep = state.episodes.find(function (e) { return e.id === args.episodeId; });
    if (!ep) fail('Episode not found (it may have expired)', 404);
    if (ep.worker !== args.workerId) fail('This episode was issued to a different contributor', 403);
    if (ep.status !== 'issued') fail('This episode has already been submitted', 409);
    const err = Sim.validateActions(args.actions);
    if (err) fail(err);
    const w = getWorker(state, ep.worker);
    const res = recordTeleop(state, w, ep, args.actions, now, { trusted: !!ctx.trusted, clientOutcome: args.clientOutcome });
    const s = res.session;
    log(state, 'session', w.name + (s.outcome.success ? ' completed ' : ' attempted ') + (s.kind === 'intervention' ? 'a takeover' : 'a demo') + ' of "' + Sim.SKILLS[s.skill].name + '" (' + s.status + ', ' + money(s.pay.totalCents) + ')', now);
    const b = s.bounty ? state.bounties.find(function (x) { return x.id === s.bounty; }) : null;
    return {
      session: sessionView(state, s, false), metrics: res.metrics, verified: s.flags.indexOf('replay_mismatch') < 0,
      bounty: b ? bountyView(state, b, w) : null, balances: balances(state, w.id), level: teleopLevel(state, w.id),
    };
  }

  function replayEvent(state, rt, ev) {
    const pol = policyFor(state, rt, ev.policyVersion);
    if (!pol) fail('That policy version is no longer available', 404);
    const res = Sim.rollout(ev.init, Policy.noisyActor(pol.act, Sim.mulberry32(ev.noiseSeed)), { frames: true });
    return {
      event: eventView(state, ev), init: ev.init, frames: res.frames, handover: ev.handover,
      handoverIndex: Math.max(0, res.frames.length - 1 - HANDOVER_STEPS),
      outcome: { success: res.state.success, failure: res.state.failure, steps: res.state.t },
    };
  }
  function opRobotAttempt(box, args) {
    const ep = box.state.episodes.find(function (e) { return e.id === args.episodeId; });
    if (!ep) fail('Episode not found', 404);
    if (!ep.eventId) fail('This episode is not a takeover of a robot failure', 404);
    const ev = box.state.events.find(function (e) { return e.id === ep.eventId; });
    if (!ev) fail('The original failure has been archived', 404);
    return replayEvent(box.state, box.rt, ev);
  }
  function opEventReplay(box, args) {
    const ev = box.state.events.find(function (e) { return e.id === args.eventId; });
    if (!ev) fail('Failure event not found', 404);
    return replayEvent(box.state, box.rt, ev);
  }

  function opSubmitGlasses(box, args, now) {
    const state = box.state;
    const w = getWorker(state, args.workerId);
    if (w.modes.indexOf('glasses') < 0) fail(w.name + ' is not enrolled for smart-glasses capture', 403);
    let bounty = null;
    if (args.bountyId) {
      bounty = state.bounties.find(function (b) { return b.id === args.bountyId; });
      if (!bounty) fail('Bounty not found', 404);
      if (bounty.status !== 'open') fail('That bounty is no longer open', 409);
      if (bounty.mode !== 'glasses') fail('That bounty needs teleoperation, not footage');
    }
    const skillId = bounty ? bounty.skill : args.skill;
    getSkill(skillId);
    const c = args.consent || {};
    const missing = [];
    if (!c.siteConsent) missing.push('workplace permission');
    if (!c.bystanderNotice) missing.push('bystander notice');
    if (!c.privacyZones) missing.push('privacy zones respected');
    if (missing.length) fail('Consent checklist incomplete: ' + missing.join(', '), 422);
    const media = sanitizeMedia(args.media);
    const workplace = typeof args.workplace === 'string' ? args.workplace.replace(/[<>]/g, '').slice(0, 80) : null;
    const s = recordGlasses(state, w, bounty, skillId, media, c, workplace, now);
    log(state, 'session', w.name + ' uploaded ' + fmtSec(media.durationSec) + ' of smart-glasses footage for "' + Sim.SKILLS[skillId].name + '" (' + s.status + ', ' + money(s.pay.totalCents) + ')', now);
    return { session: sessionView(state, s, false), balances: balances(state, w.id), bounty: bounty ? bountyView(state, bounty, w) : null };
  }

  function opReviewQueue(box) {
    const state = box.state;
    return { queue: state.sessions.filter(function (s) { return s.status === 'review'; }).map(function (s) { return sessionView(state, s, true); }) };
  }
  function opReviewSession(box, args, now) {
    const state = box.state;
    const s = state.sessions.find(function (x) { return x.id === args.sessionId; });
    if (!s) fail('Session not found', 404);
    if (s.status !== 'review') fail('That session is not awaiting review', 409);
    if (args.decision !== 'approve' && args.decision !== 'reject') fail('decision must be "approve" or "reject"');
    const note = typeof args.note === 'string' ? args.note.slice(0, 200) : '';
    settleReview(state, s, args.decision === 'approve', note, 'Ops reviewer', now);
    const w = getWorker(state, s.worker);
    log(state, 'review', (args.decision === 'approve' ? 'Approved ' : 'Rejected ') + w.name + "'s " + s.mode + ' session ' + s.id, now);
    return { session: sessionView(state, s, false) };
  }

  function opLab(box) {
    const state = box.state;
    const dep = deployedRecord(state);
    const last = state.shifts[state.shifts.length - 1] || null;
    const clusters = [];
    if (last) {
      const evs = state.events.filter(function (e) { return e.shift === last.no; });
      Object.keys(last.bySkill).forEach(function (sk) {
        const st = last.bySkill[sk];
        Object.keys(st.modes).forEach(function (mode) {
          const mine = evs.filter(function (e) { return e.skill === sk && e.failure === mode; });
          clusters.push({ skill: sk, skillName: Sim.SKILLS[sk].name, failure: mode, failureLabel: Sim.FAILURES[mode].label, count: st.modes[mode], rate: r3(st.modes[mode] / st.n), damageCents: st.modes[mode] * Sim.FAILURES[mode].damageCents, events: mine.slice(0, 3).map(function (e) { return eventView(state, e); }) });
        });
      });
      clusters.sort(function (a, b) { return b.count - a.count; });
    }
    const dataset = {};
    activeSkills(state).forEach(function (sk) { dataset[sk] = { skillName: Sim.SKILLS[sk].name, teleop: 0, glasses: 0, interventions: 0, pending: 0, rejected: 0, contributors: 0 }; });
    const contributors = {};
    state.demos.forEach(function (d) {
      const x = dataset[d.skill];
      if (!x) return;
      if (d.status === 'approved') {
        if (d.source === 'glasses') x.glasses++; else x.teleop++;
        if (d.intervention) x.interventions++;
        (contributors[d.skill] = contributors[d.skill] || new Set()).add(d.worker);
      } else if (d.status === 'pending') x.pending++;
      else x.rejected++;
    });
    Object.keys(contributors).forEach(function (sk) { if (dataset[sk]) dataset[sk].contributors = contributors[sk].size; });
    return {
      deployed: dep ? policyFull(state, dep) : null,
      policies: state.policies.slice().reverse().map(function (p) { return policyFull(state, p); }),
      sites: state.sites.map(function (s) {
        return { id: s.id, name: s.name, city: s.city, kind: s.kind, mix: s.mix, agreement: s.agreement, robots: state.robots.filter(function (r) { return r.site === s.id; }) };
      }),
      mix: fleetMix(state), lastShift: last ? shiftView(last) : null, clusters: clusters, dataset: dataset,
      recentFailures: state.events.slice(-12).reverse().map(function (e) { return eventView(state, e); }),
      optedOut: state.workers.filter(function (w) { return w.consent.dataOptOut; }).map(function (w) { return w.name; }),
      canOnboard: !state.sites.some(function (s) { return s.id === EXPANSION_SITE.id; }), expansion: EXPANSION_SITE,
      skills: activeSkills(state).map(function (sk) { return { id: sk, name: Sim.SKILLS[sk].name }; }),
      config: state.config,
    };
  }

  function opRunShift(box, args, now) {
    const res = runShift(box.state, box.rt, args, now);
    return { shift: shiftView(res.shift), failures: res.failures.length, priced: res.priced };
  }
  function opTrain(box, args, now) {
    const rec = train(box.state, box.rt, { trigger: 'manual', autoDeploy: args.autoDeploy, force: !!args.force }, now);
    const prev = rec.gate.comparedTo ? box.state.policies.find(function (p) { return p.version === rec.gate.comparedTo; }) : null;
    return { policy: policyFull(box.state, rec), previous: prev ? policyView(prev) : null };
  }
  function opDeploy(box, args, now) {
    return { policy: policyFull(box.state, deployVersion(box.state, Number(args.version), now, true)) };
  }
  function opRollout(box, args) {
    const state = box.state;
    const version = args.version ? Number(args.version) : state.deployedVersion;
    const pol = policyFor(state, box.rt, version);
    if (!pol) fail('Unknown policy version', 404);
    const skill = args.skill || activeSkills(state)[0];
    getSkill(skill);
    const seed = args.seed != null ? Number(args.seed) >>> 0 : Math.floor(Math.random() * 4294967296) >>> 0;
    const r = Sim.mulberry32(seed);
    const init = Sim.makeEpisode(r, Sim.SKILLS[skill].object);
    const res = Sim.rollout(init, Policy.noisyActor(pol.act, r), { frames: true });
    return { version: version, skill: skill, seed: seed, init: init, frames: res.frames, outcome: { success: res.state.success, failure: res.state.failure, steps: res.state.t } };
  }
  function opRunCycle(box, args, now) {
    const n = Math.round(clamp(Number(args.cycles) || 1, 1, 10));
    let res = null;
    for (let i = 0; i < n; i++) res = runCycle(box.state, box.rt, args, now);
    return res;
  }

  function opOps(box) {
    const state = box.state;
    const byKind = { base: 0, bounty: 0, quality: 0, royalty: 0 };
    let pending = 0, paidOut = 0;
    state.ledger.forEach(function (e) {
      if (e.status === 'void') return;
      if (e.kind === 'payout') { paidOut -= e.cents; return; }
      if (e.status === 'pending') { pending += e.cents; return; }
      byKind[e.kind] += e.cents;
    });
    const flagCount = function (f) { return state.sessions.filter(function (s) { return (s.flags || []).indexOf(f) >= 0; }).length; };
    return {
      review: opReviewQueue(box).queue,
      balances: state.workers.map(function (w) { return Object.assign({ worker: workerView(w), level: teleopLevel(state, w.id) }, balances(state, w.id)); }),
      ledger: state.ledger.slice(-80).reverse().map(function (e) {
        const w = state.workers.find(function (x) { return x.id === e.worker; });
        return Object.assign({}, e, { workerName: w ? w.name : e.worker });
      }),
      totals: { byKind: byKind, pending: pending, paidOut: paidOut },
      integrity: {
        replayMismatch: flagCount('replay_mismatch'), fasterThanRealtime: flagCount('faster_than_realtime'),
        rejected: state.sessions.filter(function (s) { return s.status === 'rejected'; }).length,
        reviewed: state.sessions.filter(function (s) { return s.review; }).length,
        sessions: state.sessions.length,
        optedOut: state.workers.filter(function (w) { return w.consent.dataOptOut; }).length,
      },
      config: state.config,
    };
  }

  function opPayout(box, args, now) {
    const state = box.state;
    const w = getWorker(state, args.workerId);
    const bal = balances(state, w.id);
    const amount = args.amountCents != null ? Math.min(Math.round(Number(args.amountCents) || 0), bal.available) : bal.available;
    if (!(amount > 0)) fail('Nothing available to pay out yet', 409);
    const e = addLedger(state, w.id, 'payout', -amount, null, 'Instant payout to ' + w.payout + ' (simulated)', 'paid', now);
    log(state, 'payout', w.name + ' cashed out ' + money(amount), now);
    return { receipt: { id: e.id, reference: 'PO-' + e.id.toUpperCase(), amountCents: amount, method: w.payout, at: now }, balances: balances(state, w.id) };
  }
  function opPayAll(box, args, now) {
    const state = box.state;
    let count = 0, total = 0;
    state.workers.forEach(function (w) {
      const bal = balances(state, w.id);
      if (bal.available > 0) {
        addLedger(state, w.id, 'payout', -bal.available, null, 'Weekly payout run to ' + w.payout + ' (simulated)', 'paid', now);
        count++; total += bal.available;
      }
    });
    if (!count) fail('No balances to pay out', 409);
    log(state, 'payout', 'Payout run: ' + money(total) + ' to ' + count + ' contributors', now);
    return { count: count, totalCents: total };
  }

  function opUpdateConsent(box, args, now) {
    const state = box.state;
    const w = getWorker(state, args.workerId);
    const before = w.consent.dataOptOut;
    ['audio', 'openResearch', 'dataOptOut'].forEach(function (k) { if (typeof args[k] === 'boolean') w.consent[k] = args[k]; });
    if (before !== w.consent.dataOptOut) {
      log(state, 'system', w.name + (w.consent.dataOptOut ? ' opted out of future training: their data is excluded from the next model' : ' opted back in to training'), now);
    }
    return { consent: Object.assign({}, w.consent) };
  }

  function opUpdateConfig(box, args, now) {
    const c = box.state.config;
    function setNum(key, lo, hi, digits) {
      if (args[key] == null || args[key] === '') return;
      const v = Number(args[key]);
      if (!Number.isFinite(v)) fail(key + ' must be a number');
      const f = Math.pow(10, digits);
      c[key] = Math.round(clamp(v, lo, hi) * f) / f;
    }
    setNum('royaltyRate', 0, 0.3, 3);
    setNum('teleopBaseCentsPerHour', 0, 10000, 0);
    setNum('glassesBaseCentsPerHour', 0, 5000, 0);
    setNum('autoApproveQa', 0.3, 0.95, 2);
    setNum('tasksPerRobot', 1, 30, 0);
    if (typeof args.autoDeploy === 'boolean') c.autoDeploy = args.autoDeploy;
    log(box.state, 'system', 'Platform settings updated', now);
    return { config: c };
  }

  function opOnboardSite(box, args, now) {
    const state = box.state;
    if (state.sites.some(function (s) { return s.id === EXPANSION_SITE.id; })) fail(EXPANSION_SITE.name + ' is already onboarded', 409);
    const site = addSite(state, EXPANSION_SITE, now);
    log(state, 'site', 'Onboarded ' + site.name + ' (' + site.city + ') with 3 humanoids. New task in the fleet: "' + Sim.SKILLS.load_plates.name + '"', now);
    return { site: site };
  }

  function opReset(box, args, now) {
    box.state = createState({ now: now, seed: args.seed });
    box.rt = createRuntime();
    return { ok: true };
  }

  const OPS = {
    health: function (box) { return { ok: true, schema: SCHEMA, shiftNo: box.state.shiftNo }; },
    overview: opOverview,
    workers: function (box) { return { workers: box.state.workers.map(workerView), config: box.state.config }; },
    workerDetail: opWorkerDetail, updateConsent: opUpdateConsent, bounties: opBounties,
    issueEpisode: opIssueEpisode, submitEpisode: opSubmitEpisode, robotAttempt: opRobotAttempt, eventReplay: opEventReplay,
    submitGlasses: opSubmitGlasses, reviewQueue: opReviewQueue, reviewSession: opReviewSession,
    lab: opLab, runShift: opRunShift, train: opTrain, deploy: opDeploy, rollout: opRollout, runCycle: opRunCycle,
    ops: opOps, payout: opPayout, payAll: opPayAll, updateConfig: opUpdateConfig, onboardSite: opOnboardSite, reset: opReset,
  };

  const ROUTES = [
    { op: 'health', method: 'GET', path: '/api/health' },
    { op: 'overview', method: 'GET', path: '/api/overview' },
    { op: 'workers', method: 'GET', path: '/api/workers' },
    { op: 'workerDetail', method: 'GET', path: '/api/workers/:workerId' },
    { op: 'updateConsent', method: 'PATCH', path: '/api/workers/:workerId/consent' },
    { op: 'bounties', method: 'GET', path: '/api/bounties' },
    { op: 'issueEpisode', method: 'POST', path: '/api/episodes' },
    { op: 'submitEpisode', method: 'POST', path: '/api/episodes/:episodeId/submit' },
    { op: 'robotAttempt', method: 'GET', path: '/api/episodes/:episodeId/robot-attempt' },
    { op: 'submitGlasses', method: 'POST', path: '/api/glasses/sessions' },
    { op: 'reviewQueue', method: 'GET', path: '/api/review' },
    { op: 'reviewSession', method: 'POST', path: '/api/sessions/:sessionId/review' },
    { op: 'lab', method: 'GET', path: '/api/lab' },
    { op: 'eventReplay', method: 'GET', path: '/api/events/:eventId/replay' },
    { op: 'runShift', method: 'POST', path: '/api/fleet/shift' },
    { op: 'train', method: 'POST', path: '/api/train' },
    { op: 'deploy', method: 'POST', path: '/api/policies/:version/deploy' },
    { op: 'rollout', method: 'POST', path: '/api/rollout' },
    { op: 'runCycle', method: 'POST', path: '/api/loop/cycle' },
    { op: 'ops', method: 'GET', path: '/api/ops' },
    { op: 'payout', method: 'POST', path: '/api/payouts' },
    { op: 'payAll', method: 'POST', path: '/api/payouts/batch' },
    { op: 'updateConfig', method: 'PATCH', path: '/api/config' },
    { op: 'onboardSite', method: 'POST', path: '/api/sites' },
    { op: 'reset', method: 'POST', path: '/api/reset' },
  ];

  function matchRoute(method, pathname) {
    const parts = pathname.split('/');
    for (let i = 0; i < ROUTES.length; i++) {
      const r = ROUTES[i];
      if (r.method !== method) continue;
      const pat = r.path.split('/');
      if (pat.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let j = 0; j < pat.length && ok; j++) {
        if (pat[j].charAt(0) === ':') {
          try { params[pat[j].slice(1)] = decodeURIComponent(parts[j]); } catch (e) { ok = false; }
        } else if (pat[j] !== parts[j]) ok = false;
      }
      if (ok) return { route: r, params: params };
    }
    return null;
  }

  /** Client-side: turn an op + args into { method, url, body }. */
  function buildRequest(op, args) {
    const r = ROUTES.find(function (x) { return x.op === op; });
    if (!r) throw new Error('Unknown operation: ' + op);
    const rest = Object.assign({}, args || {});
    const path = r.path.replace(/:(\w+)/g, function (_, k) {
      const v = rest[k];
      delete rest[k];
      return encodeURIComponent(v == null ? '' : String(v));
    });
    if (r.method === 'GET') {
      const qs = Object.keys(rest).filter(function (k) { return rest[k] != null; }).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(rest[k]); }).join('&');
      return { method: r.method, url: path + (qs ? '?' + qs : ''), body: null };
    }
    return { method: r.method, url: path, body: Object.assign({}, rest, { workerId: args && args.workerId }) };
  }

  function dispatch(box, op, args, ctx) {
    if (!Object.prototype.hasOwnProperty.call(OPS, op)) fail('Unknown operation: ' + op, 404);
    ctx = ctx || {};
    return OPS[op](box, args || {}, ctx.now || Date.now(), ctx);
  }

  return {
    SCHEMA: SCHEMA, LoopError: LoopError, ROUTES: ROUTES, DEFAULT_CONFIG: DEFAULT_CONFIG,
    createState: createState, createRuntime: createRuntime, dispatch: dispatch, matchRoute: matchRoute, buildRequest: buildRequest,
    isMutating: function (op) { const r = ROUTES.find(function (x) { return x.op === op; }); return !!r && r.method !== 'GET'; },
    // exposed for tests and tooling
    _internals: { balances: balances, teleopLevel: teleopLevel, fleetMix: fleetMix, glassesQa: glassesQa, priceTeleop: priceTeleop, policyFor: policyFor },
  };
});
