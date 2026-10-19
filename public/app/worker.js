/* LoopWork: worker app (wallet, bounties, sessions, dividends, privacy). */
(function (LW) {
  'use strict';
  const Sim = window.LoopSim;
  const esc = LW.esc;

  LW.bountyCard = function (b, opts) {
    opts = opts || {};
    const pctFilled = b.target ? Math.min(1, b.filled / b.target) : 0;
    const action = b.mode === 'teleop' ? (b.kind === 'intervention' ? 'Take over' : 'Start demos') : 'Capture footage';
    const href = '#/' + (b.mode === 'teleop' ? 'teleop' : 'glasses') + '?bounty=' + encodeURIComponent(b.id);
    const progress = b.unit === 'hour' ? Math.round(b.filled) + ' / ' + b.target + ' min' : b.unit === 'takeover' ? 'one takeover' : b.filled + ' / ' + b.target + ' demos';
    const lvlNote = b.mode === 'teleop' && b.effectiveRateCents !== b.rateCents ? ' <span class="tiny soft">(' + LW.money(b.effectiveRateCents) + ' at your level)</span>' : '';
    return '<div class="bounty k-' + b.kind + '">' +
      '<div class="row">' + LW.kindPill(b) + '<span class="pill">' + (LW.OBJ_ICON[Sim.SKILLS[b.skill].object] || '') + ' ' + esc(b.skillName) + '</span>' +
      '<span class="rate">' + LW.money(b.rateCents) + '<small>' + LW.unitLabel(b.unit) + '</small></span></div>' +
      '<div class="title">' + esc(b.title) + lvlNote + '</div>' +
      '<div class="reason">' + esc(b.reason) + '</div>' +
      (b.unit !== 'takeover' ? LW.bar(pctFilled) : '') +
      '<div class="row between"><span class="tiny soft">' + progress + ' · shift ' + b.createdShift + '</span>' +
      (opts.noAction ? '' : (b.eligible ? '<a class="btn primary sm" href="' + href + '">' + action + '</a>' : '<span class="tiny soft">Not enrolled for ' + (b.mode === 'teleop' ? 'teleop' : 'glasses') + '</span>')) +
      '</div></div>';
  };

  function sessionRow(s) {
    const icon = s.mode === 'glasses' ? '🕶️' : s.kind === 'intervention' ? '🛟' : '🎮';
    const what = s.mode === 'glasses' ? LW.dur(s.activeSec) + ' footage' + (s.retarget ? ' → ' + s.retarget.yielded + ' robot demos' : '') : (s.outcome.success ? 'Success' : LW.failLabel(s.outcome.failure)) + ' in ' + LW.dur(s.activeSec);
    return '<tr><td class="nowrap">' + LW.ago(s.createdAt) + '</td><td>' + icon + ' ' + esc(s.kind === 'intervention' ? 'Takeover' : s.mode === 'glasses' ? 'Glasses' : s.kind === 'practice' ? 'Practice' : 'Demo') + '</td>' +
      '<td>' + esc(s.skillName) + '<div class="tiny soft">' + esc(what) + '</div></td>' +
      '<td>' + (s.qa && s.qa.score != null ? Math.round(s.qa.score * 100) : '–') + (s.flags && s.flags.length ? ' <span class="pill bad" title="' + esc(s.flags.join(', ')) + '">flagged</span>' : '') + '</td>' +
      '<td>' + LW.statusPill(s.status) + '</td><td class="right nowrap"><b>' + LW.money(s.pay.totalCents) + '</b></td></tr>';
  }

  function toggle(key, label, desc, checked, locked) {
    return '<div class="toggle-row"><div><div style="font-weight:600">' + esc(label) + (locked ? ' <span class="pill">always on</span>' : '') + '</div><div class="small muted">' + esc(desc) + '</div></div>' +
      '<label class="switch"><input type="checkbox" data-consent="' + key + '" ' + (checked ? 'checked' : '') + ' ' + (locked ? 'disabled' : '') + '><span></span></label></div>';
  }

  LW.pages.worker = async function (main, params) {
    const me = await LW.api.call('workerDetail', { workerId: LW.me() });
    const w = me.worker, bal = me.balances, lvl = me.level;
    const filter = params.filter || 'all';
    const bounties = me.bounties.filter(function (b) {
      if (filter === 'teleop') return b.mode === 'teleop' && b.kind !== 'intervention';
      if (filter === 'glasses') return b.mode === 'glasses';
      if (filter === 'takeovers') return b.kind === 'intervention';
      return true;
    });
    const nextPct = lvl.next ? Math.min(1, lvl.approved / lvl.next.at) : 1;
    const dep = me.deployed;
    const shares = dep ? Object.keys(dep.bySkill || {}) : [];
    const royalties = me.royalties || [];

    main.innerHTML =
      '<section class="grid three">' +
        '<div class="card"><div class="row" style="gap:12px"><span class="avatar lg">' + esc(w.initials) + '</span><div><h2>' + esc(w.name) + '</h2><div class="small muted">' + esc(w.persona) + ' · ' + esc(w.city) + ', ' + esc(w.country) + '</div>' +
          '<div class="row" style="margin-top:6px">' + w.modes.map(function (m) { return '<span class="pill accent">' + (m === 'teleop' ? '🎮 Teleop' : '🕶️ Glasses') + '</span>'; }).join('') + (w.simulated ? '<span class="pill">simulated contributor</span>' : '') + '</div></div></div>' +
          '<div style="margin-top:14px" class="small muted">Device: ' + esc(w.device) + '</div>' +
          (w.modes.indexOf('teleop') >= 0 ?
            '<div style="margin-top:12px"><div class="row between small"><b>L' + lvl.level + ' · ' + esc(lvl.name) + '</b><span class="muted">×' + lvl.mult + ' bounty rate</span></div>' + LW.bar(nextPct) +
            '<div class="tiny soft" style="margin-top:4px">' + (lvl.next ? lvl.approved + ' / ' + lvl.next.at + ' accepted teleop demos to L' + lvl.next.level + ' (' + esc(lvl.next.name) + ')' : 'Top level reached') + '</div></div>' : '') +
        '</div>' +
        '<div class="card"><div class="card-head"><h2>Wallet</h2><span class="small muted">paid to ' + esc(w.payout) + '</span></div>' +
          '<div class="row between"><div><div class="small muted">Available now</div><div style="font-size:30px;font-weight:750">' + LW.money(bal.available) + '</div></div>' +
          '<button class="btn primary" data-act="payout" ' + (bal.available > 0 ? '' : 'disabled') + '>Cash out</button></div>' +
          '<div class="row small muted" style="margin:6px 0 12px;gap:14px"><span>Pending review ' + LW.money(bal.pending) + '</span><span>Lifetime ' + LW.money(bal.earned) + '</span><span>Paid out ' + LW.money(bal.paidOut) + '</span></div>' +
          LW.hStacked([{ label: 'Earnings mix', values: bal.byKind }], ['base', 'bounty', 'quality', 'royalty']) +
          '<div class="small muted" style="margin-top:8px">Effective rate <b>' + (me.activeHours >= 0.05 ? LW.money(me.effectiveHourlyCents) + '/hr' : 'n/a yet') + '</b> over ' + me.activeHours + ' hours of sessions, plus dividends</div>' +
        '</div>' +
        '<div class="card"><div class="card-head"><h2>Your data dividends</h2><span class="small muted">' + (dep ? 'live policy v' + dep.version : '') + '</span></div>' +
          (dep ? '<div class="row" style="gap:18px"><div><div class="small muted">Your share of the live model</div><div style="font-size:30px;font-weight:750">' + (dep.share * 100).toFixed(1) + '%</div></div><div class="small muted">' + dep.inModel + ' of your demos<br>are in v' + dep.version + '</div></div>' : '<div class="empty">No live model yet.</div>') +
          (shares.length ? '<div class="stack" style="margin-top:10px">' + shares.map(function (sk) {
            return '<div class="small"><div class="row between"><span>' + esc(LW.skillName(sk)) + '</span><span class="muted">' + Math.round(dep.bySkill[sk] * 100) + '% of skill credit</span></div>' + LW.bar(dep.bySkill[sk]) + '</div>';
          }).join('') + '</div>' : '<p class="small muted" style="margin-top:10px">None of your data is in the live model yet. Complete a takeover or capture footage, then retrain in the Robot lab.</p>') +
          '<div style="margin-top:12px"><div class="small muted">Dividends per shift (last ' + royalties.length + ')</div>' + LW.sparkBars(royalties.map(function (r) { return r.cents; })) +
          '<div class="tiny soft">Total dividends ' + LW.money(bal.byKind.royalty) + '</div></div>' +
        '</div>' +
      '</section>' +
      '<section class="card"><div class="card-head"><h2>Open bounties</h2><div class="chips">' +
        [['all', 'All'], ['takeovers', 'Takeovers'], ['teleop', 'Teleop demos'], ['glasses', 'Glasses']].map(function (f) {
          return '<button class="chip ' + (filter === f[0] ? 'on' : '') + '" data-filter="' + f[0] + '">' + f[1] + '</button>';
        }).join('') + '</div></div>' +
        (bounties.length ? '<div class="bounty-grid">' + bounties.map(function (b) { return LW.bountyCard(b); }).join('') + '</div>'
          : '<div class="empty">No open bounties here right now. The fleet is doing well! Practice in <a href="#/teleop">Teleoperate</a>, or run a loop cycle to see new failures.</div>') +
      '</section>' +
      '<section class="grid wide-left">' +
        '<div class="card"><div class="card-head"><h2>Your sessions</h2><span class="small muted">' + me.sessions.length + ' most recent</span></div>' +
          (me.sessions.length ? '<div class="table-wrap"><table><thead><tr><th>When</th><th>Type</th><th>Skill</th><th>QA</th><th>Status</th><th class="right">Pay</th></tr></thead><tbody>' + me.sessions.map(sessionRow).join('') + '</tbody></table></div>'
            : '<div class="empty">No sessions yet. Pick a bounty above to start earning.</div>') +
        '</div>' +
        '<div class="card"><div class="card-head"><h2>Privacy &amp; data rights</h2></div>' +
          toggle('faceBlur', 'Blur faces & screens', 'On-device redaction before anything leaves your glasses.', true, true) +
          toggle('privacyZones', 'Privacy zones auto-pause', 'Recording stops in bathrooms, change rooms and other marked zones.', true, true) +
          toggle('audio', 'Capture audio', 'Off by default. Narration can help robots learn, but it\'s your call.', w.consent.audio, false) +
          toggle('openResearch', 'Share with open research datasets', 'Lets academic labs use your de-identified data (no extra pay).', w.consent.openResearch, false) +
          toggle('dataOptOut', 'Opt out of future training', 'Your data is excluded from the next model. Models already trained keep paying you dividends.', w.consent.dataOptOut, false) +
        '</div>' +
      '</section>';

    main.addEventListener('click', async function (e) {
      const f = e.target.closest('[data-filter]');
      if (f) { location.hash = '#/worker?filter=' + f.getAttribute('data-filter'); return; }
      const b = e.target.closest('[data-act="payout"]');
      if (b) {
        await LW.busy(b, async function () {
          const r = await LW.api.call('payout', { workerId: w.id });
          LW.toast('💸 Paid ' + LW.money(r.receipt.amountCents) + ' to ' + esc(r.receipt.method) + ' · ref ' + esc(r.receipt.reference), 'ok', 6000);
          LW.refresh();
        });
      }
    });
    main.addEventListener('change', async function (e) {
      const c = e.target.closest('[data-consent]');
      if (!c) return;
      const args = { workerId: w.id };
      args[c.getAttribute('data-consent')] = c.checked;
      try {
        await LW.api.call('updateConsent', args);
        LW.toast('Privacy settings saved', 'ok');
      } catch (err) { c.checked = !c.checked; LW.fail(err); }
    });
    return null;
  };
})(window.LW);
