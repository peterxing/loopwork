/* LoopWork: overview ("The loop") and "How it works" pages. */
(function (LW) {
  'use strict';
  const Sim = window.LoopSim;
  const esc = LW.esc;

  const STAGE_ICON = { capture: '🕶️', verify: '✅', train: '🧠', deploy: '🚀', fleet: '🤖', detect: '🚨', price: '🎯', pay: '💸' };
  const FEED_ICON = { fleet: '🤖', bounty: '🎯', session: '🧑‍🔧', train: '🧠', deploy: '🚀', dividend: '💸', payout: '🏦', review: '✅', system: '⚙️', site: '🏗️', loop: '🔁' };

  const LC = 308, LR = 225, NW = 150, NH = 84; // loop diagram geometry (viewBox 616)
  function nodePos(i) {
    const a = -Math.PI / 2 + i * Math.PI / 4;
    return { x: LC + LR * Math.cos(a), y: LC + LR * Math.sin(a), a: a };
  }

  function loopSvg(stages, center) {
    let s = '<svg class="loop-svg" viewBox="0 0 ' + (LC * 2) + ' ' + (LC * 2) + '" role="img" aria-label="The LoopWork feedback loop">';
    s += '<circle id="loopRing" class="loop-ring" cx="' + LC + '" cy="' + LC + '" r="' + LR + '"/>';
    for (let i = 0; i < 8; i++) {
      const a = -Math.PI / 2 + (i + 0.5) * Math.PI / 4;
      const px = LC + LR * Math.cos(a), py = LC + LR * Math.sin(a);
      const tx = -Math.sin(a), ty = Math.cos(a), nx = Math.cos(a), ny = Math.sin(a);
      const pts = [[px + tx * 7, py + ty * 7], [px - tx * 5 + nx * 6, py - ty * 5 + ny * 6], [px - tx * 5 - nx * 6, py - ty * 5 - ny * 6]];
      s += '<polygon class="loop-arrow" points="' + pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ') + '"/>';
    }
    s += '<text class="loop-center-small" x="' + LC + '" y="' + (LC - 44) + '" text-anchor="middle">' + esc(center.top) + '</text>';
    s += '<text id="loopBig" class="loop-center-big" x="' + LC + '" y="' + (LC + 10) + '" text-anchor="middle">' + esc(center.big) + '</text>';
    s += '<text class="loop-center-small" x="' + LC + '" y="' + (LC + 40) + '" text-anchor="middle">' + esc(center.bottom) + '</text>';
    s += '<text class="loop-center-small" x="' + LC + '" y="' + (LC + 62) + '" text-anchor="middle" style="font-size:11px">' + esc(center.note || '') + '</text>';
    stages.forEach(function (st, i) {
      const p = nodePos(i);
      const x = p.x - NW / 2, y = p.y - NH / 2;
      s += '<g class="loop-node" data-stage="' + i + '"><rect x="' + x + '" y="' + y + '" width="' + NW + '" height="' + NH + '" rx="12"/>' +
        '<foreignObject x="' + x + '" y="' + y + '" width="' + NW + '" height="' + NH + '"><div xmlns="http://www.w3.org/1999/xhtml" class="n-box">' + nodeHtml(st, i) + '</div></foreignObject></g>';
    });
    return s + '</svg>';
  }
  function nodeHtml(st, i) {
    return '<div class="n-label">' + (i + 1) + ' · ' + (STAGE_ICON[st.key] || '') + ' ' + esc(st.label) + '</div><div class="n-value">' + esc(st.value) + '</div><div class="n-sub">' + esc(st.sub) + '</div>';
  }
  /** The same stages as a vertical list, shown instead of the ring on narrow screens. */
  function loopList(stages) {
    return '<ol class="loop-list" aria-label="The LoopWork feedback loop">' + stages.map(function (st, i) {
      return '<li class="loop-node" data-stage="' + i + '"><div class="n-box">' + nodeHtml(st, i) + '</div></li>';
    }).join('') + '<li class="small muted" style="text-align:center">↻ and round again</li></ol>';
  }

  async function animateCycle(root, cycles) {
    const ring = LW.$('#loopRing', root);
    if (ring) ring.classList.add('flow');
    const nodes = LW.$$('.loop-node', root);
    const stageOf = function (n) { return Number(n.getAttribute('data-stage')); };
    let k = 0;
    const spin = setInterval(function () {
      nodes.forEach(function (n) { n.classList.toggle('active', stageOf(n) === k % 8); });
      k++;
    }, 160);
    let res;
    try {
      res = await LW.api.call('runCycle', { cycles: cycles || 1 });
    } finally {
      clearInterval(spin);
    }
    nodes.forEach(function (n) { n.classList.remove('active'); });
    for (let i = 0; i < res.cycle.stages.length; i++) {
      const mine = nodes.filter(function (n) { return stageOf(n) === i; });
      mine.forEach(function (n) {
        n.classList.add('active');
        const box = n.querySelector('.n-box');
        if (box) box.innerHTML = nodeHtml(res.cycle.stages[i], i);
      });
      await LW.sleep(320);
      mine.forEach(function (n) { n.classList.remove('active'); });
    }
    if (ring) ring.classList.remove('flow');
    return res;
  }

  function checklist(me, ov) {
    const sessions = me.sessions || [];
    const items = [
      { done: sessions.some(function (s) { return s.kind === 'intervention' && s.outcome && s.outcome.success; }), text: 'Take over a robot that failed (teleop)', href: '#/teleop' },
      { done: Object.keys(me.demos || {}).some(function (k) { const x = me.demos[k]; return (x.approved || 0) - (x.interventions || 0) >= 2; }), text: 'Teach a struggling skill: 2–3 demos usually close the gap', href: '#/teleop' },
      { done: sessions.some(function (s) { return s.mode === 'glasses'; }), text: 'Capture smart-glasses footage on the job', href: '#/glasses' },
      { done: !!(me.deployed && me.deployed.inModel > 0), text: 'Retrain so your data is in the live model (Robot lab)', href: '#/lab' },
      { done: me.balances.byKind.royalty > 0, text: 'Earn a data dividend from a fleet shift', href: '#/lab' },
      { done: (me.thcPayouts || []).some(function (p) { return p.status === 'confirmed'; }), text: 'Get paid in Transhuman Coin (THC wallet)', href: '#/wallet' },
      { done: ov.cycleNo > 0, text: 'Run the whole loop (button above)', href: null },
    ];
    return '<div class="checklist">' + items.map(function (it) {
      const inner = '<span class="tick ' + (it.done ? 'on' : '') + '">' + (it.done ? '✓' : '') + '</span><span class="' + (it.done ? 'done' : '') + '">' + esc(it.text) + '</span>';
      return it.href && !it.done ? '<a href="' + it.href + '">' + inner + '</a>' : '<div>' + inner + '</div>';
    }).join('') + '</div>';
  }

  LW.pages.overview = async function (main) {
    const results = await Promise.all([LW.api.call('overview'), LW.api.call('workerDetail', { workerId: LW.me() })]);
    const ov = results[0], me = results[1];
    const k = ov.kpis;
    const dep = ov.deployed;
    const lastShift = ov.shifts[ov.shifts.length - 1];
    const prevShift = ov.shifts[ov.shifts.length - 2];
    const delta = lastShift && prevShift ? lastShift.success - prevShift.success : null;
    const stages = ov.lastCycle ? ov.lastCycle.stages : [];
    const versionLabels = ov.versions.map(function (v) { return 'v' + v.version; });
    const skillIds = Object.keys(Sim.SKILLS).filter(function (sk) { return ov.versions.some(function (v) { return v.bySkill[sk] != null; }); });
    const shifts = ov.shifts;
    const meName = LW.workerById(LW.me()) ? LW.workerById(LW.me()).name : 'You';

    main.innerHTML =
      '<section class="card hero">' +
        '<div><div class="eyebrow">Humanoid training-data feedback loop</div>' +
        '<h1>Get paid to teach humanoids.</h1>' +
        '<p class="lead">Physical workers earn by wearing smart glasses while they do their normal job, or by remotely operating humanoids. Every robot failure becomes a paid task. Every verified demonstration improves the fleet. And contributors keep earning <b>data dividends</b> for as long as the model they trained does paid work.</p>' +
        '<div class="row"><button class="btn primary" data-act="cycle">▶ Run one loop cycle</button><button class="btn" data-act="cycle5">Run 5 cycles</button><a class="btn ghost" href="#/worker">Open the worker app →</a></div></div>' +
        '<div class="hero-side">' +
          '<div class="small muted">Live policy</div>' +
          '<div class="hero-metric"><span class="big">' + (dep ? 'v' + dep.version : '–') + '</span><span class="muted">eval ' + LW.pct(k.evalSuccess) + '</span></div>' +
          '<div class="small muted">Fleet success, last shift</div>' +
          '<div class="hero-metric"><span class="big">' + LW.pct(k.fleetSuccess) + '</span>' + (delta != null ? '<span class="delta ' + (delta >= 0 ? 'up' : 'down') + '">' + (delta >= 0 ? '▲ ' : '▼ ') + Math.abs(Math.round(delta * 100)) + ' pts</span>' : '') + '</div>' +
          '<div class="small muted">' + k.robots + ' humanoids · ' + k.sites + ' sites · shift ' + ov.shiftNo + ' · cycle ' + ov.cycleNo + '</div>' +
        '</div>' +
      '</section>' +
      '<section class="kpis">' +
        kpi('Paid to workers', LW.money(k.earnedCents), LW.money(k.royaltiesCents) + ' as data dividends') +
        kpi('Effective pay', LW.money(k.effectiveHourlyCents) + '/hr', 'per hour of capture & teleop sessions') +
        kpi('Open bounties', String(k.openBounties), LW.money(k.openValueCents) + ' on offer') +
        kpi('Fleet revenue', LW.money(k.revenueCents), 'last shift · ' + LW.money(k.damageCents) + ' damage') +
        kpi('Verified demos', String(k.demos), k.contributors + ' contributors') +
        kpi('Dividend rate', Math.round(ov.config.royaltyRate * 100) + '%', 'of fleet revenue → contributors') +
      '</section>' +
      '<section class="grid wide-left">' +
        '<div class="card"><div class="card-head"><h2>The loop</h2><span class="small muted">' + (ov.lastCycle ? (ov.lastCycle.no ? 'cycle ' + ov.lastCycle.no + ' · ' + LW.ago(ov.lastCycle.at) : 'pilot · ' + LW.ago(ov.lastCycle.at)) : '') + '</span></div>' +
          '<div id="loopHolder">' + loopSvg(stages, { top: 'fleet success', big: LW.pct(k.fleetSuccess), bottom: dep ? 'policy v' + dep.version + ' live' : 'no policy', note: 'cycle ' + ov.cycleNo }) + loopList(stages) + '</div>' +
          '<p class="small muted" style="text-align:center;margin-top:6px">Robots work → failures become priced bounties → workers capture or take over → QA → retrain → safety gate → deploy → dividends.</p></div>' +
        '<div class="stack lg">' +
          '<div class="card"><div class="card-head"><h2>Skills in the fleet</h2><a class="small" href="#/lab">Robot lab →</a></div>' + skillsHtml(ov.skills) + '</div>' +
          '<div class="card"><div class="card-head"><h2>Get started as ' + esc(meName) + '</h2><a class="small" href="#/worker">Worker app →</a></div>' + checklist(me, ov) + '</div>' +
        '</div>' +
      '</section>' +
      '<section class="grid two">' +
        '<div class="card"><div class="card-head"><h2>Policy success by version</h2><span class="small muted">fixed evaluation suite, with actuation noise</span></div>' +
          LW.lineChart({
            labels: versionLabels, aria: 'Evaluation success by policy version',
            series: skillIds.map(function (sk) { return { name: Sim.SKILLS[sk].name, color: LW.SKILL_COLOR[sk], values: ov.versions.map(function (v) { return v.bySkill[sk] == null ? null : v.bySkill[sk]; }) }; })
              .concat([{ name: 'Fleet-weighted overall', color: '--cp-text', dashed: true, width: 2, values: ov.versions.map(function (v) { return v.overall; }) }]),
          }) + '</div>' +
        '<div class="card"><div class="card-head"><h2>Fleet outcomes by shift</h2><span class="small muted">' + (lastShift ? lastShift.tasks + ' tasks per shift' : '') + '</span></div>' +
          LW.stackedBars({
            labels: shifts.map(function (s) { return 'S' + s.no; }), aria: 'Fleet task outcomes by shift',
            stacks: [{ name: 'Succeeded', color: '--cp-success', values: shifts.map(function (s) { return s.ok; }) }].concat(Object.keys(Sim.FAILURES).map(function (f) {
              return { name: Sim.FAILURES[f].label, color: LW.FAIL_COLOR[f], values: shifts.map(function (s) { return s.modes[f] || 0; }) };
            })),
          }) + '</div>' +
      '</section>' +
      '<section class="grid two">' +
        '<div class="card"><div class="card-head"><h2>Who earns</h2><span class="small muted">lifetime, by pay type</span></div>' +
          LW.hStacked(ov.earnings.filter(function (e) { return e.earned > 0 || e.pending > 0; }).map(function (e) {
            return { label: esc(e.name) + ' <span class="soft">· ' + esc(e.persona) + (e.simulated ? '' : ' ★') + '</span>', values: e.byKind };
          }), ['base', 'bounty', 'quality', 'royalty']) + '</div>' +
        '<div class="card"><div class="card-head"><h2>Activity</h2><span class="small muted">' + (LW.api.mode === 'server' ? 'server' : 'in-browser') + ' event log</span></div><div class="feed">' +
          ov.feed.map(function (f) { return '<div class="feed-item"><span>' + (FEED_ICON[f.kind] || '•') + '</span><span>' + esc(f.text) + '</span><span class="when">' + LW.ago(f.at) + '</span></div>'; }).join('') +
        '</div></div>' +
      '</section>';

    async function run(btn, n) {
      LW.$$('[data-act^="cycle"]', main).forEach(function (b) { b.disabled = true; });
      try {
        const before = k.fleetSuccess;
        const res = await animateCycle(main, n);
        const after = res.shift.success;
        LW.toast('Loop cycle ' + res.cycle.no + ' done: fleet ' + LW.pct(before) + ' → <b>' + LW.pct(after) + '</b>' + (res.trained ? ' · trained v' + res.trained.version + (res.trained.status === 'deployed' ? ' (deployed)' : ' (' + res.trained.status + ')') : ''), 'ok', 6000);
        await LW.sleep(250);
        LW.refresh();
      } catch (e) {
        LW.fail(e);
        LW.$$('[data-act^="cycle"]', main).forEach(function (b) { b.disabled = false; });
      }
    }
    main.addEventListener('click', function (e) {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.getAttribute('data-act') === 'cycle') run(b, 1);
      if (b.getAttribute('data-act') === 'cycle5') run(b, 5);
    });
    return null;
  };

  function kpi(label, value, sub) {
    return '<div class="kpi"><div class="label">' + esc(label) + '</div><div class="value">' + esc(value) + '</div><div class="sub">' + esc(sub) + '</div></div>';
  }

  function skillsHtml(skills) {
    if (!skills.length) return '<div class="empty">No skills in the fleet yet.</div>';
    return skills.map(function (s) {
      const v = s.fleetSuccess;
      return '<div class="skill-row"><div><div style="font-weight:600">' + (LW.OBJ_ICON[s.object] || '') + ' ' + esc(s.name) + '</div><div class="tiny soft">' + s.demos + ' demos · ' + (s.openBounties ? '<span style="color:var(--cp-accent)">' + s.openBounties + ' open bounties</span>' : 'no open bounties') + '</div></div>' +
        '<div>' + LW.bar(v, LW.successClass(v)) + '<div class="tiny soft" style="margin-top:3px">' + (s.topFailure ? 'Top issue: ' + esc(s.topFailure) : 'No failures last shift') + ' · eval ' + LW.pct(s.evalSuccess) + '</div></div>' +
        '<div class="right" style="font-weight:700">' + LW.pct(v) + '</div></div>';
    }).join('');
  }

  // ------------------------------------------------------------ How it works
  LW.pages.about = async function (main) {
    const cfg = (await LW.api.call('overview')).config;
    main.innerHTML = '<section class="card prose">' +
      '<div class="eyebrow">How LoopWork works</div><h1>A data flywheel that pays the people who teach robots</h1>' +
      '<p style="margin-top:10px">Humanoid robots learn physical skills from demonstrations, and the hardest data to get is the long tail of real workplaces. LoopWork turns that data supply into fair, flexible work for the people who already have the skills: housekeepers, kitchen hands, baristas, warehouse pickers, retail staff.</p>' +
      '<h2>Two ways to earn</h2><ul>' +
      '<li><b>Wear smart glasses at work.</b> Egocentric video of real tasks, captured with consent, with on-device QA and face blurring. Paid ' + LW.money(cfg.glassesBaseCentsPerHour) + '/hr of verified footage, plus a bounty bonus per hour for skills the fleet is struggling with, times a quality multiplier.</li>' +
      '<li><b>Teleoperate humanoids remotely.</b> Do demonstrations, or take over a robot at the exact moment it failed (an intervention). Paid ' + LW.money(cfg.teleopBaseCentsPerHour) + '/hr of session time (minimum one minute per session) whether or not you succeed, plus per-demo or per-takeover bounties. Levels (L1–L3) raise your rate as your accepted demos grow.</li></ul>' +
      '<h2>The loop</h2><ul>' +
      '<li><b>Fleet works:</b> humanoids run paid tasks at customer sites with the current policy.</li>' +
      '<li><b>Failures detected:</b> each failure is clustered by skill and failure mode, and the robot\'s state ~1 s before the failure is saved for a human takeover.</li>' +
      '<li><b>Bounties priced:</b> pay is set dynamically from failure rate, damage risk and data scarcity, so money flows to the gaps that matter.</li>' +
      '<li><b>Workers capture:</b> glasses footage gives breadth; teleop takeovers give the recovery data ordinary demos can\'t (the DAgger effect).</li>' +
      '<li><b>Verify &amp; QA:</b> every teleop demo is re-simulated on the server from its actions, so outcome claims and timing can be checked. Low-quality or suspicious sessions go to human review.</li>' +
      '<li><b>Train, evaluate, attribute:</b> each model version is evaluated on a fixed suite, and every contributor\'s data is valued by leave-one-out impact blended with volume.</li>' +
      '<li><b>Safety-gated deploy:</b> a version that regresses any skill by more than 10 points (or overall by more than 2) is blocked.</li>' +
      '<li><b>Data dividends:</b> ' + Math.round(cfg.royaltyRate * 100) + '% of every shift\'s fleet revenue is shared with the contributors whose data the live model uses, in proportion to their attributed value.</li></ul>' +
      '<h2>Pay and get paid in Transhuman Coin (THC)</h2><ul>' +
      '<li><b>Get paid in THC.</b> Workers link a crypto wallet and choose THC payouts. Cashing out converts their balance at the live THC price, and the platform treasury sends the THC on BNB Smart Chain. The money stays reserved until the transfer\'s on-chain receipt proves it arrived.</li>' +
      '<li><b>Pay in THC.</b> Anyone can pay THC into the treasury to fund training data for a skill. Once the payment is verified on-chain, it becomes a sponsored bounty that teleoperators earn from.</li>' +
      '<li><b>Your keys stay yours.</b> Transfers are approved in your own wallet (MetaMask, Trust Wallet and others). LoopWork never sees a seed phrase or private key. A built-in demo wallet on a simulated chain lets you try it all without real funds.</li></ul>' +
      '<h2>Worker protections built in</h2><ul>' +
      '<li>Time-based base pay: failed attempts are still paid for the time spent.</li>' +
      '<li>Face and screen blurring always on; privacy zones auto-pause; audio off by default; workplace permission and bystander notice are required.</li>' +
      '<li>Contributors can opt out of future training at any time. Already-trained models keep paying them dividends.</li>' +
      '<li>Transparent ledger: every cent is itemised (time, bounty, quality, dividend, payout).</li></ul>' +
      '<h2>What is simulated in this prototype</h2>' +
      '<p>The humanoid world is a deterministic 2D manipulation simulator (reach, grasp, carry, sort, with fragile items and actuation noise). The policy is a structured k-nearest-neighbour behaviour-cloning model. Retargeting glasses footage into robot actions is simulated from the contributor\'s skill profile. Bank payouts are ledger entries only, while THC payments are real BNB Smart Chain transfers when you use a real wallet (or a simulated chain with the demo wallet). Everything else (marketplace, pricing, QA, replay verification, training, evaluation, attribution, gating and dividends) runs for real.</p>' +
      (LW.api.hosted ? '<p style="margin-top:8px">On this public demo site the whole platform, including the part that would normally run on a server, runs inside your browser, and your progress stays on this device. Only the THC wallet talks to outside services: it reads THC prices (CoinGecko, DexScreener) and BNB Smart Chain data, and sends the transfers you approve in your wallet. <a href="https://github.com/peterxing/loopwork" target="_blank" rel="noopener">The source code is on GitHub</a>.</p>' : '') +
      '</section>';
    return null;
  };
})(window.LW);
