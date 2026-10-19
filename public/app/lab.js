/* LoopWork: robot lab (train/eval/attribution, fleet, failures, policy registry). */
(function (LW) {
  'use strict';
  const Sim = window.LoopSim;
  const esc = LW.esc;

  function skillBars(bySkill) {
    return Object.keys(bySkill).map(function (sk) {
      const v = bySkill[sk].success;
      return '<div class="skill-row"><div>' + (LW.OBJ_ICON[Sim.SKILLS[sk].object] || '') + ' ' + esc(LW.skillName(sk)) + '</div>' + LW.bar(v, LW.successClass(v)) + '<div class="right"><b>' + LW.pct(v) + '</b></div></div>';
    }).join('');
  }

  function attributionTable(attr, limit) {
    if (!attr || !attr.length) return '<div class="empty">No attribution yet.</div>';
    return '<div class="table-wrap"><table><thead><tr><th>Contributor</th><th class="right">Dividend share</th><th>Credit by skill</th><th class="right">Demos</th><th class="right">Takeovers</th></tr></thead><tbody>' +
      attr.slice(0, limit || 50).map(function (a) {
        return '<tr><td>' + esc(a.name) + (a.simulated || a.name === 'You' ? '' : ' <span class="pill accent">you</span>') + '</td><td class="right"><b>' + (a.share * 100).toFixed(1) + '%</b></td><td class="small">' +
          Object.keys(a.bySkill || {}).map(function (sk) { return esc(LW.skillName(sk)) + ' ' + Math.round(a.bySkill[sk] * 100) + '%' + (a.marginal && a.marginal[sk] ? ' <span class="soft">(+' + Math.round(a.marginal[sk] * 100) + ' pts LOO)</span>' : ''); }).join('<br>') +
          '</td><td class="right">' + a.demos + '</td><td class="right">' + a.interventions + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function showTrainResult(res) {
    const p = res.policy, prev = res.previous;
    const rows = Object.keys(p.bySkill).map(function (sk) {
      const nv = p.bySkill[sk].success, ov = prev && prev.bySkill[sk] ? prev.bySkill[sk].success : null;
      const d = ov == null ? null : nv - ov;
      return '<tr><td>' + esc(LW.skillName(sk)) + '</td><td class="right">' + (ov == null ? '–' : LW.pct(ov)) + '</td><td class="right"><b>' + LW.pct(nv) + '</b></td><td class="right">' +
        (d == null ? '<span class="pill link">new</span>' : '<span class="delta ' + (d >= 0 ? 'up' : 'down') + '">' + (d >= 0 ? '+' : '') + Math.round(d * 100) + '</span>') + '</td></tr>';
    }).join('');
    const gate = p.gate.passed ? '<div class="callout neutral">✅ Safety gate passed: no skill regressed by more than 10 points.' + (p.status === 'deployed' ? ' <b>Deployed to the fleet.</b>' : ' Not auto-deployed.') + '</div>'
      : '<div class="callout">⛔ Safety gate blocked deployment: ' + esc(p.gate.reasons.join('; ')) + '. The fleet stays on the previous version (you can override in the registry).</div>';
    LW.modal({
      title: 'Policy v' + p.version + ' trained', wide: true,
      body: '<p class="small muted">' + p.nDemos + ' verified demos (' + p.newDemos + ' new) from ' + p.contributors + ' contributors · ' + p.nSamples.toLocaleString() + ' state-action samples' + (p.excludedOptOut ? ' · ' + p.excludedOptOut + ' demos excluded (opt-out)' : '') + '</p>' +
        '<div class="grid two" style="margin-top:12px"><div><h3>Evaluation (fixed suite, 20 episodes per skill)</h3><table style="margin-top:6px"><thead><tr><th>Skill</th><th class="right">v' + (prev ? prev.version : '–') + '</th><th class="right">v' + p.version + '</th><th class="right">Δ pts</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<div style="margin-top:10px">' + gate + '</div></div>' +
        '<div><h3>Who made it better: dividend shares</h3><p class="tiny soft" style="margin:4px 0 6px">Half data volume × quality, half leave-one-out impact on evaluated success, weighted by each skill\'s revenue.</p>' + attributionTable(p.attribution, 8) + '</div></div>',
    });
  }

  function replayModal(title, run) {
    let player = null, scene = null;
    const m = LW.modal({
      title: title, wide: true,
      body: '<div class="scene-wrap"><canvas class="scene" id="replayCanvas"></canvas></div><p class="small muted" id="replayNote" style="margin-top:8px"></p>',
      onClose: function () { if (player) player.stop(); if (scene) scene.destroy(); },
    });
    scene = new LW.Scene(LW.$('#replayCanvas', m.el));
    player = LW.playFrames(scene, run.init.type, run.frames, {
      handoverIndex: run.handoverIndex, outcome: run.outcome,
      hud: function (i) { return { left: run.label || 'REPLAY', right: 't ' + (i / Sim.HZ).toFixed(1) + 's' }; },
    });
    player.done.then(function (finished) {
      if (!finished) return;
      const note = LW.$('#replayNote', m.el);
      if (note) note.innerHTML = run.outcome.success ? '✅ Succeeded in ' + (run.outcome.steps / Sim.HZ).toFixed(1) + 's' : '❌ ' + esc(LW.failLabel(run.outcome.failure)) + ' after ' + (run.outcome.steps / Sim.HZ).toFixed(1) + 's' + (run.handoverIndex != null ? '. The circle marks where a human takeover starts.' : '');
    });
    return m;
  }
  LW.replayModal = replayModal;

  LW.pages.lab = async function (main) {
    const lab = await LW.api.call('lab');
    const dep = lab.deployed;
    const ls = lab.lastShift;
    let watchScene = null, watchPlayer = null;

    main.innerHTML =
      '<section class="grid wide-left">' +
        '<div class="card"><div class="card-head"><div><div class="eyebrow">Robot lab</div><h2>Live policy ' + (dep ? 'v' + dep.version : '–') + '</h2></div><span class="small muted">' + (dep ? 'deployed ' + LW.ago(dep.deployedAt) + ' · ' + dep.nDemos + ' demos · ' + dep.contributors + ' contributors' : '') + '</span></div>' +
          (dep ? skillBars(dep.bySkill) + '<div class="row between" style="margin-top:10px"><span class="small muted">Fleet-weighted eval success</span><b style="font-size:20px">' + LW.pct(dep.overall) + '</b></div>' : '<div class="empty">No policy deployed.</div>') +
          '<div class="row" style="margin-top:14px"><button class="btn primary" data-act="train">🧠 Train &amp; evaluate</button><button class="btn" data-act="shift">🤖 Run fleet shift</button>' +
          (lab.canOnboard ? '<button class="btn ghost" data-act="onboard">🏗️ Onboard ' + esc(lab.expansion.name) + '</button>' : '') + '</div>' +
          (lab.optedOut.length ? '<p class="tiny soft" style="margin-top:8px">Opted out of future training: ' + esc(lab.optedOut.join(', ')) + '</p>' : '') +
        '</div>' +
        '<div class="card"><div class="card-head"><h2>Watch the robot</h2><div class="row"><select id="watchSkill">' + lab.skills.map(function (s) { return '<option value="' + s.id + '">' + esc(s.name) + '</option>'; }).join('') + '</select><button class="btn sm" data-act="watch">▶ Watch</button></div></div>' +
          '<div class="scene-wrap"><canvas class="scene" id="watchCanvas"></canvas></div><p class="small muted" id="watchNote" style="margin-top:6px">Random task, live policy, real actuation noise.</p></div>' +
      '</section>' +
      '<section class="card"><div class="card-head"><h2>Fleet</h2><span class="small muted">' + (ls ? 'shift ' + ls.no + ': ' + ls.ok + '/' + ls.tasks + ' tasks · ' + LW.money(ls.revenueCents) + ' revenue · ' + LW.money(ls.damageCents) + ' damage · ' + LW.money(ls.dividendCents) + ' dividends' : '') + '</span></div>' +
        '<div class="site-grid">' + lab.sites.map(function (s) {
          return '<div class="site"><div style="font-weight:650">' + esc(s.name) + '</div><div class="tiny soft">' + esc(s.kind) + ' · ' + esc(s.city) + ' · ' + Object.keys(s.mix).map(function (t) { return (LW.OBJ_ICON[t] || t) + ' ' + Math.round(s.mix[t] * 100) + '%'; }).join(' ') + '</div><div style="margin-top:8px">' +
            s.robots.map(function (r) {
              const cls = r.status === 'autonomous' ? 'ok' : 'bad';
              return '<div class="robot"><span class="dot ' + cls + '"></span><b>' + esc(r.name) + '</b><span class="soft">' + (r.lastShift ? r.lastShift.ok + '/' + r.lastShift.tasks : 'new') + '</span><span class="spacer"></span><span class="tiny soft">' + (r.status === 'autonomous' ? 'autonomous' : esc(LW.failLabel(r.lastOutcome))) + '</span></div>';
            }).join('') + '</div></div>';
        }).join('') + '</div></section>' +
      '<section class="grid two">' +
        '<div class="card"><div class="card-head"><h2>Failure clusters, last shift</h2><a class="small" href="#/worker?filter=takeovers">Takeover bounties →</a></div>' +
          (lab.clusters.length ? '<div class="table-wrap"><table><thead><tr><th>Skill</th><th>Failure</th><th class="right">Count</th><th class="right">Damage</th><th></th></tr></thead><tbody>' + lab.clusters.map(function (c) {
            return '<tr><td>' + esc(c.skillName) + '</td><td><span class="dot" style="background:var(' + LW.FAIL_COLOR[c.failure] + ')"></span> ' + esc(c.failureLabel) + '</td><td class="right">' + c.count + ' <span class="soft">(' + LW.pct(c.rate) + ')</span></td><td class="right">' + LW.money(c.damageCents) + '</td><td class="right">' +
              (c.events[0] ? '<button class="btn sm" data-replay="' + esc(c.events[0].id) + '">Replay</button>' : '') + '</td></tr>';
          }).join('') + '</tbody></table></div>' : '<div class="empty">No failures in the last shift 🎉</div>') + '</div>' +
        '<div class="card"><div class="card-head"><h2>Training data</h2><span class="small muted">verified demos by skill and source</span></div><div class="table-wrap"><table><thead><tr><th>Skill</th><th class="right">Teleop</th><th class="right">Takeovers</th><th class="right">Glasses</th><th class="right">Pending</th><th class="right">Contributors</th></tr></thead><tbody>' +
          Object.keys(lab.dataset).map(function (sk) {
            const d = lab.dataset[sk];
            return '<tr><td>' + esc(d.skillName) + '</td><td class="right">' + (d.teleop - d.interventions) + '</td><td class="right">' + d.interventions + '</td><td class="right">' + d.glasses + '</td><td class="right">' + d.pending + '</td><td class="right">' + d.contributors + '</td></tr>';
          }).join('') + '</tbody></table></div></div>' +
      '</section>' +
      '<section class="card"><div class="card-head"><h2>Policy registry</h2><span class="small muted">every version is reproducible from its exact demo set</span></div><div class="table-wrap"><table><thead><tr><th>Version</th><th>Trained</th><th class="right">Demos</th>' +
        Object.keys(Sim.SKILLS).filter(function (sk) { return lab.policies.some(function (p) { return p.bySkill[sk]; }); }).map(function (sk) { return '<th class="right">' + esc(LW.skillName(sk)) + '</th>'; }).join('') +
        '<th class="right">Overall</th><th>Gate</th><th>Status</th><th>Top contributors</th><th></th></tr></thead><tbody>' +
        lab.policies.map(function (p) {
          const cols = Object.keys(Sim.SKILLS).filter(function (sk) { return lab.policies.some(function (q) { return q.bySkill[sk]; }); });
          return '<tr><td><b>v' + p.version + '</b></td><td class="nowrap small">' + LW.ago(p.createdAt) + '<div class="tiny soft">' + esc(p.trigger) + '</div></td><td class="right">' + p.nDemos + (p.newDemos ? ' <span class="soft">(+' + p.newDemos + ')</span>' : '') + '</td>' +
            cols.map(function (sk) { return '<td class="right">' + (p.bySkill[sk] ? LW.pct(p.bySkill[sk].success) : '–') + '</td>'; }).join('') +
            '<td class="right"><b>' + LW.pct(p.overall) + '</b></td><td>' + (p.gate.passed ? '<span class="pill ok">pass</span>' : '<span class="pill bad" title="' + esc(p.gate.reasons.join('; ')) + '">blocked</span>') + '</td><td>' + LW.statusPill(p.status) + '</td>' +
            '<td class="small">' + p.attribution.slice(0, 3).map(function (a) { return esc(a.name) + ' ' + Math.round(a.share * 100) + '%'; }).join(', ') + '</td>' +
            '<td class="right nowrap"><button class="btn sm ghost" data-details="' + p.version + '">Details</button>' + (p.status !== 'deployed' ? '<button class="btn sm" data-deploy="' + p.version + '">' + (p.status === 'retired' ? 'Roll back' : 'Deploy') + '</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div></section>';

    function initWatch() {
      if (!watchScene) watchScene = new LW.Scene(LW.$('#watchCanvas', main));
      const sk = LW.$('#watchSkill', main).value;
      watchScene.draw({ type: Sim.SKILLS[sk].object, gx: 68, gy: 30, ox: 30, oy: 30, held: false, targetBin: Sim.OBJECTS[Sim.SKILLS[sk].object].bin, hud: { left: 'policy v' + (dep ? dep.version : '–'), right: 'idle' } });
    }
    initWatch();
    LW.$('#watchSkill', main).addEventListener('change', initWatch);

    main.addEventListener('click', async function (e) {
      const btn = e.target.closest('button');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      if (act === 'train') {
        const res = await LW.busy(btn, function () { return LW.api.call('train', {}); });
        if (res) { showTrainResult(res); LW.render(); }
      } else if (act === 'shift') {
        const res = await LW.busy(btn, function () { return LW.api.call('runShift', {}); });
        if (res) {
          LW.toast('🤖 Shift ' + res.shift.no + ': ' + res.shift.ok + '/' + res.shift.tasks + ' tasks (' + LW.pct(res.shift.success) + ') · ' + LW.money(res.shift.dividendCents) + ' paid as data dividends · ' + res.priced.interventions + ' new takeover bounties', 'ok', 6500);
          LW.render();
        }
      } else if (act === 'onboard') {
        const res = await LW.busy(btn, function () { return LW.api.call('onboardSite', {}); });
        if (res) { LW.toast('🏗️ ' + esc(res.site.name) + ' onboarded with 3 humanoids. Run a fleet shift to see the new skill gap.', 'ok', 6500); LW.render(); }
      } else if (act === 'watch') {
        if (watchPlayer) watchPlayer.stop();
        const sk = LW.$('#watchSkill', main).value;
        const run = await LW.busy(btn, function () { return LW.api.call('rollout', { skill: sk }); });
        if (!run) return;
        initWatch();
        LW.$('#watchNote', main).textContent = 'Running policy v' + run.version + '…';
        watchPlayer = LW.playFrames(watchScene, run.init.type, run.frames, { outcome: run.outcome, hud: function (i) { return { left: 'policy v' + run.version + ' · autonomous', right: 't ' + (i / Sim.HZ).toFixed(1) + 's' }; } });
        const finished = await watchPlayer.done;
        if (finished && LW.$('#watchNote', main)) LW.$('#watchNote', main).innerHTML = run.outcome.success ? '✅ Success in ' + (run.outcome.steps / Sim.HZ).toFixed(1) + 's' : '❌ ' + esc(LW.failLabel(run.outcome.failure)) + '. Failures like this become takeover bounties after a fleet shift.';
      } else if (btn.hasAttribute('data-replay')) {
        const id = btn.getAttribute('data-replay');
        const run = await LW.busy(btn, function () { return LW.api.call('eventReplay', { eventId: id }); });
        if (run) replayModal(run.event.summary + ' · ' + run.event.site, Object.assign({ label: 'REPLAY · ' + run.event.robot + ' · policy v' + run.event.policyVersion }, run));
      } else if (btn.hasAttribute('data-deploy')) {
        const v = Number(btn.getAttribute('data-deploy'));
        const res = await LW.busy(btn, function () { return LW.api.call('deploy', { version: v }); });
        if (res) { LW.toast('🚀 Policy v' + v + ' deployed to the fleet', 'ok'); LW.render(); }
      } else if (btn.hasAttribute('data-details')) {
        const v = Number(btn.getAttribute('data-details'));
        const p = lab.policies.find(function (x) { return x.version === v; });
        const prev = lab.policies.find(function (x) { return x.version === (p.gate.comparedTo || -1); });
        showTrainResult({ policy: p, previous: prev || null });
      }
    });
    return { destroy: function () { if (watchPlayer) watchPlayer.stop(); if (watchScene) watchScene.destroy(); } };
  };
})(window.LW);
