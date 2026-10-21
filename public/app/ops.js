/* LoopWork: ops & pay console (review queue, payouts, ledger, integrity, settings). */
(function (LW) {
  'use strict';
  const Sim = window.LoopSim;
  const esc = LW.esc;

  function framesFromDemo(init, flat) {
    const s = Sim.reset(init);
    const frames = [Sim.frame(s)];
    for (let i = 0; i < flat.length / 3 && !s.done; i++) {
      Sim.step(s, Sim.decodeAction(flat, i));
      frames.push(Sim.frame(s));
    }
    return { init: init, frames: frames, outcome: { success: s.success, failure: s.failure, steps: s.t } };
  }

  function reviewCard(s) {
    const qaScore = s.qa && s.qa.score != null ? Math.round(s.qa.score * 100) : '–';
    const pending = (s.pay.bountyCents || 0) + (s.pay.qualityCents || 0);
    let detail = '';
    if (s.mode === 'teleop') {
      detail = '<div class="small muted">' + (s.outcome.success ? 'Succeeded' : esc(LW.failLabel(s.outcome.failure))) + ' in ' + LW.dur(s.activeSec) + ' · efficiency ' + Math.round(s.qa.efficiency * 100) + ' · smoothness ' + Math.round(s.qa.smoothness * 100) + ' · safety ' + Math.round(s.qa.safety * 100) + '</div>' +
        (s.demo ? '<button class="btn sm" data-replay-session="' + esc(s.id) + '" style="margin-top:6px">▶ Replay demo</button>' : '');
    } else {
      detail = (s.media && s.media.thumbs && s.media.thumbs.length ? '<div class="thumbs" style="margin:6px 0">' + s.media.thumbs.map(function (t) { return '<img alt="Redacted preview" src="' + t + '">'; }).join('') + '</div>' : '') +
        '<div class="small muted">' + LW.dur(s.activeSec) + ' of ' + esc(s.media.source) + ' footage · ' + s.media.width + '×' + s.media.height + ' · exposure ' + Math.round(s.qa.exposure * 100) + ' · sharpness ' + Math.round(s.qa.sharpness * 100) + ' · stability ' + Math.round(s.qa.stability * 100) + (s.workplace ? ' · ' + esc(s.workplace) : '') + '</div>' +
        '<div class="tiny soft">Consent: workplace ✓ bystanders ✓ privacy zones ✓ · audio ' + (s.consent && s.consent.audio ? 'on' : 'off') + ' · ' + (s.retarget ? s.retarget.yielded + ' retargeted demos pending' : '') + '</div>';
    }
    return '<div class="bounty"><div class="row"><span class="avatar" style="width:30px;height:30px;font-size:11px">' + esc((s.workerName || '?').split(' ').map(function (p) { return p[0]; }).join('').slice(0, 3)) + '</span><b>' + esc(s.workerName) + '</b>' +
      '<span class="pill">' + (s.mode === 'glasses' ? '🕶️ glasses' : s.kind === 'intervention' ? '🛟 takeover' : '🎮 teleop') + '</span><span class="pill">' + esc(s.skillName) + '</span><span class="spacer"></span><span class="pill warn">QA ' + qaScore + '</span></div>' +
      (s.flags && s.flags.length ? '<div class="callout">⚠️ Integrity flags: ' + s.flags.map(function (f) { return '<b>' + esc(f.replace(/_/g, ' ')) + '</b>'; }).join(', ') + '</div>' : '') +
      detail +
      '<div class="row between"><span class="small muted">' + LW.money(pending) + ' bonus pending · ' + LW.ago(s.createdAt) + '</span><span class="row"><button class="btn sm danger" data-review="reject" data-id="' + esc(s.id) + '">Reject</button><button class="btn sm primary" data-review="approve" data-id="' + esc(s.id) + '">Approve</button></span></div></div>';
  }

  LW.pages.ops = async function (main) {
    const ops = await LW.api.call('ops');
    const cfg = ops.config;
    LW.cfg = cfg;
    const t = ops.totals;
    const integ = ops.integrity;

    main.innerHTML =
      '<section class="kpis">' +
        kpi('Time pay', LW.money(t.byKind.base), 'paid even when attempts fail') +
        kpi('Bounties', LW.money(t.byKind.bounty), 'targeted at fleet gaps') +
        kpi('Quality bonuses', LW.money(t.byKind.quality), 'QA multiplier ×0.7–1.3') +
        kpi('Data dividends', LW.money(t.byKind.royalty), Math.round(cfg.royaltyRate * 100) + '% of fleet revenue') +
        kpi('Pending review', LW.money(t.pending), ops.review.length + ' sessions in queue') +
        kpi('Paid out', LW.money(t.paidOut), t.processing ? LW.money(t.processing) + ' more on its way in THC' : 'instant & batch payouts') +
      '</section>' +
      '<section class="grid wide-left">' +
        '<div class="card"><div class="card-head"><h2>Review queue</h2><span class="small muted">low-QA or flagged sessions; bonus pay waits for a decision</span></div>' +
          (ops.review.length ? '<div class="stack">' + ops.review.map(reviewCard).join('') + '</div>' : '<div class="empty">Queue is clear ✓<br><span class="small">Tip: submit glasses footage in a dim kitchen, or a sloppy teleop demo, to see review in action.</span></div>') + '</div>' +
        '<div class="stack lg">' +
          '<div class="card"><h2>Integrity signals</h2>' +
            '<div class="paylines"><div><span>Sessions</span><b>' + integ.sessions + '</b></div><div><span>Replay mismatches <span class="soft">(client claim ≠ server re-sim)</span></span><b>' + integ.replayMismatch + '</b></div>' +
            '<div><span>Faster than real time</span><b>' + integ.fasterThanRealtime + '</b></div><div><span>Rejected / failed attempts</span><b>' + integ.rejected + '</b></div>' +
            '<div><span>Human-reviewed</span><b>' + integ.reviewed + '</b></div><div><span>Contributors opted out of training</span><b>' + integ.optedOut + '</b></div></div>' +
            '<p class="tiny soft" style="margin-top:8px">Every teleop demo is re-simulated from its raw actions on the server. Outcomes, timing and QA are computed there, never trusted from the client.</p></div>' +
          '<div class="card"><h2>Platform economics</h2>' +
            setting('royaltyRate', 'Data dividend rate', '% of fleet revenue paid to contributors', Math.round(cfg.royaltyRate * 100), 0, 30, 1, '%') +
            setting('teleopBase', 'Teleop time pay', '$ per hour of active control', cfg.teleopBaseCentsPerHour / 100, 0, 100, 1, '$/hr') +
            setting('glassesBase', 'Glasses base pay', '$ per hour of verified footage', cfg.glassesBaseCentsPerHour / 100, 0, 50, 0.5, '$/hr') +
            setting('autoApproveQa', 'Auto-approve QA bar', 'Teleop demos below this go to review', Math.round(cfg.autoApproveQa * 100), 30, 95, 1, '') +
            setting('tasksPerRobot', 'Tasks per robot per shift', 'Fleet throughput in the simulation', cfg.tasksPerRobot, 1, 30, 1, '') +
            '<div class="toggle-row"><div><div style="font-weight:600">Auto-deploy</div><div class="small muted">Deploy new versions that pass the safety gate</div></div><label class="switch"><input type="checkbox" id="autoDeploy" ' + (cfg.autoDeploy ? 'checked' : '') + '><span></span></label></div>' +
            '<div class="row" style="margin-top:10px"><button class="btn primary" data-act="save">Save settings</button><button class="btn danger ghost" data-act="reset">Reset demo</button></div></div>' +
        '</div>' +
      '</section>' +
      '<section class="card"><div class="card-head"><h2>Contributor balances</h2><button class="btn" data-act="payall">🏦 Run payout batch</button></div><div class="table-wrap"><table><thead><tr><th>Contributor</th><th>Modes</th><th>Teleop level</th><th class="right">Available</th><th class="right">Pending</th><th class="right">Lifetime</th><th class="right">Dividends</th><th class="right">Paid out</th><th></th></tr></thead><tbody>' +
        ops.balances.map(function (b) {
          return '<tr><td><b>' + esc(b.worker.name) + '</b><div class="tiny soft">' + esc(b.worker.persona) + ' · ' + esc(b.worker.city) + (b.worker.payoutMethod === 'thc' && b.worker.thcNetwork ? ' · 💎 paid in THC' : '') + '</div></td><td class="small">' + b.worker.modes.map(function (m) { return m === 'teleop' ? '🎮' : '🕶️'; }).join(' ') + '</td>' +
            '<td class="small">' + (b.worker.modes.indexOf('teleop') >= 0 ? 'L' + b.level.level + ' · ' + b.level.approved + ' demos' : '–') + '</td>' +
            '<td class="right"><b>' + LW.money(b.available) + '</b></td><td class="right">' + LW.money(b.pending) + '</td><td class="right">' + LW.money(b.earned) + '</td><td class="right">' + LW.money(b.byKind.royalty) + '</td><td class="right">' + LW.money(b.paidOut) + (b.processing ? '<div class="tiny soft">+' + LW.money(b.processing) + ' in THC on its way</div>' : '') + '</td>' +
            '<td class="right"><button class="btn sm" data-pay="' + esc(b.worker.id) + '" ' + (b.available > 0 ? '' : 'disabled') + '>Pay</button></td></tr>';
        }).join('') + '</tbody></table></div></section>' +
      '<section class="card" id="thcTreasury"><div class="loading"><span class="spinner"></span> Loading the THC treasury…</div></section>' +
      '<section class="card"><div class="card-head"><h2>Ledger</h2><span class="small muted">latest 80 entries · every cent itemised</span></div><div class="table-wrap"><table><thead><tr><th>When</th><th>Contributor</th><th>Type</th><th>Memo</th><th>Status</th><th class="right">Amount</th></tr></thead><tbody>' +
        ops.ledger.map(function (e) {
          return '<tr><td class="nowrap small">' + LW.ago(e.at) + '</td><td>' + esc(e.workerName) + '</td><td><span class="dot" style="background:var(' + (LW.KIND_COLOR[e.kind] || '--cp-text') + ')"></span> ' + esc(LW.KIND_LABEL[e.kind] || e.kind) + '</td><td class="small">' + esc(e.memo) + '</td><td>' + LW.statusPill(e.status) + '</td><td class="right nowrap"><b>' + LW.money(e.cents) + '</b></td></tr>';
        }).join('') + '</tbody></table></div></section>';

    main.addEventListener('input', function (e) {
      const r = e.target.closest('input[type="range"]');
      if (r) LW.$('[data-out="' + r.id + '"]', main).textContent = r.value;
    });
    main.addEventListener('click', async function (e) {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.hasAttribute('data-review')) {
        const decision = btn.getAttribute('data-review');
        const res = await LW.busy(btn, function () { return LW.api.call('reviewSession', { sessionId: btn.getAttribute('data-id'), decision: decision }); });
        if (res) { LW.toast((decision === 'approve' ? '✅ Approved: bonus released and demos added to training data' : '🚫 Rejected: time pay kept, bonus voided'), decision === 'approve' ? 'ok' : ''); LW.render(); }
      } else if (btn.hasAttribute('data-replay-session')) {
        const s = ops.review.find(function (x) { return x.id === btn.getAttribute('data-replay-session'); });
        if (s && s.demo) LW.replayModal('Review: ' + s.workerName + ' · ' + s.skillName, Object.assign({ label: 'REVIEW REPLAY · ' + s.workerName }, framesFromDemo(s.demo.init, s.demo.actions)));
      } else if (btn.hasAttribute('data-pay')) {
        const res = await LW.busy(btn, function () { return LW.api.call('payout', { workerId: btn.getAttribute('data-pay') }); });
        if (res) {
          LW.toast(res.thcPayout ? '💎 Queued ' + esc(res.thcPayout.thc) + ' THC for ' + esc(res.thcPayout.workerName) + '. Pay it in the THC treasury below.' : '💸 ' + LW.money(res.receipt.amountCents) + ' sent to ' + esc(res.receipt.method) + ' · ' + esc(res.receipt.reference), 'ok');
          LW.render();
        }
      } else if (btn.getAttribute('data-act') === 'payall') {
        const res = await LW.busy(btn, function () { return LW.api.call('payAll', {}); });
        if (res) { LW.toast('🏦 Payout run: ' + LW.money(res.totalCents) + ' to ' + res.count + ' contributors' + (res.thcQueued ? '. ' + res.thcQueued + (res.thcQueued === 1 ? ' chose THC and is' : ' chose THC and are') + ' queued for the treasury below.' : ''), 'ok', 6000); LW.render(); }
      } else if (btn.getAttribute('data-act') === 'save') {
        const v = function (id) { return Number(LW.$('#' + id, main).value); };
        const res = await LW.busy(btn, function () {
          return LW.api.call('updateConfig', {
            royaltyRate: v('royaltyRate') / 100, teleopBaseCentsPerHour: Math.round(v('teleopBase') * 100), glassesBaseCentsPerHour: Math.round(v('glassesBase') * 100),
            autoApproveQa: v('autoApproveQa') / 100, tasksPerRobot: v('tasksPerRobot'), autoDeploy: LW.$('#autoDeploy', main).checked,
          });
        });
        if (res) { LW.cfg = res.config; LW.toast('Settings saved', 'ok'); LW.render(); }
      } else if (btn.getAttribute('data-act') === 'reset') {
        if (!window.confirm('Reset the whole demo to the pilot state? All sessions, models and balances will be cleared.')) return;
        const res = await LW.busy(btn, function () { return LW.api.call('reset', {}); });
        if (res) {
          if (LW.api.mode !== 'server' && LW.thc) LW.thc.resetDemo();
          LW.toast('Demo reset to the pilot', 'ok');
          location.hash = '#/overview';
          LW.render();
        }
      }
    });
    const treasuryEl = LW.$('#thcTreasury', main);
    if (treasuryEl && LW.renderThcTreasury) {
      LW.renderThcTreasury(treasuryEl).catch(function (err) {
        if (treasuryEl.isConnected) treasuryEl.innerHTML = '<h2>💎 THC treasury</h2><p class="muted" style="margin-top:8px">Could not load: ' + esc(err.message) + '</p>';
      });
    }
    return null;
  };

  function kpi(label, value, sub) {
    return '<div class="kpi"><div class="label">' + esc(label) + '</div><div class="value">' + esc(value) + '</div><div class="sub">' + esc(sub) + '</div></div>';
  }
  function setting(id, label, desc, value, min, max, step, unit) {
    return '<div class="toggle-row"><div><div style="font-weight:600">' + esc(label) + '</div><div class="small muted">' + esc(desc) + '</div></div>' +
      '<div class="row" style="flex-wrap:nowrap"><input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + value + '" style="width:120px"><span class="small nowrap" style="min-width:58px;text-align:right"><span data-out="' + id + '">' + value + '</span> ' + esc(unit) + '</span></div></div>';
  }
})(window.LW);
