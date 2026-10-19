/* LoopWork: teleoperation console (live control of the simulated humanoid hand). */
(function (LW) {
  'use strict';
  const Sim = window.LoopSim;
  const esc = LW.esc;
  const KEYMAP = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', ShiftLeft: 'shift', ShiftRight: 'shift' };

  async function chooser(main) {
    const me = LW.workerById(LW.me());
    if (me && me.modes.indexOf('teleop') < 0) {
      main.innerHTML = '<section class="card"><h2>Teleoperation</h2><p class="muted" style="margin-top:8px">' + esc(me.name) + ' is enrolled for smart-glasses capture only. Switch "Acting as" to <b>You</b>, Kofi, Priya, Aisha or Hana to teleoperate.</p></section>';
      return null;
    }
    const data = await LW.api.call('bounties', { workerId: LW.me() });
    const tele = data.bounties.filter(function (b) { return b.mode === 'teleop'; });
    const skills = Object.keys(Sim.SKILLS);
    main.innerHTML =
      '<section class="card"><div class="card-head"><div><div class="eyebrow">Remote teleoperation</div><h2>Pick a robot to help</h2></div>' +
      '<div class="row"><select id="practiceSkill">' + skills.map(function (s) { return '<option value="' + s + '">' + esc(Sim.SKILLS[s].name) + '</option>'; }).join('') + '</select><button class="btn" id="practiceBtn">Practice (time pay only)</button></div></div>' +
      '<p class="small muted">Takeovers drop you into the exact moment a humanoid failed in the field, about a second before the mistake. They are the most valuable data in the loop and pay the most. Skill demos start from a fresh scene.</p></section>' +
      '<section class="card">' + (tele.length ? '<div class="bounty-grid">' + tele.map(function (b) { return LW.bountyCard(b); }).join('') + '</div>' : '<div class="empty">No teleop bounties open right now. Try practice, or run a loop cycle to generate new failures.</div>') + '</section>';
    LW.$('#practiceBtn', main).addEventListener('click', function () {
      location.hash = '#/teleop?skill=' + LW.$('#practiceSkill', main).value;
    });
    return null;
  }

  function Console(main, data) {
    this.main = main;
    this.data = data;
    this.ep = data.episode;
    this.type = this.ep.init.type;
    this.obj = Sim.OBJECTS[this.type];
    this.bin = Sim.BINS[this.obj.bin];
    this.state = Sim.reset(this.ep.init);
    this.actions = [];
    this.trail = [];
    this.keys = {};
    this.pointer = null;
    this.pendingGrip = 0;
    this.phase = 'ready';
    this.raf = null;
    this.player = null;
    LW.activeConsole = this; // inspection hook for automated UI tests
    this.build();
  }

  Console.prototype.robotLabel = function () {
    const ev = this.data.event;
    return ev ? ev.robot + ' · ' + ev.site : 'Sim cell · practice robot';
  };

  Console.prototype.build = function () {
    const d = this.data, b = d.bounty, ev = d.event;
    const title = b ? b.title : 'Practice: ' + this.ep.skillName;
    const fragile = this.obj.fragile;
    const levelMult = d.level ? d.level.mult : 1;
    const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const task = (this.ep.init.held ? 'Carry' : 'Put') + ' the ' + esc(this.obj.label.toLowerCase()) + ' in the <b>' + esc(this.bin.label) + '</b>';
    this.main.innerHTML =
      '<section class="teleop">' +
        '<div class="card"><div class="scene-wrap"><canvas class="scene" id="scene" tabindex="0" aria-label="Teleoperation view"></canvas>' +
          '<div class="scene-overlay"><div class="msg" id="overlay">' + task + '<div class="small muted" style="margin-top:4px;font-weight:500">' + (touch ? 'Drag on the scene to steer, then press Start' : 'Move your pointer over the scene to steer, then press Start') + '</div></div></div></div>' +
          '<div class="hud"><span class="pill" id="hudTime">0.0s / ' + (Sim.T_MAX / Sim.HZ) + 's</span>' +
            '<div class="hud-gauge"><div class="gauge" title="Hand speed"><span id="hudSpeed" style="width:0%"></span>' + (fragile ? '<i style="left:' + (Sim.FRAGILE_V / Sim.VMAX * 100).toFixed(1) + '%"></i>' : '') + '</div>' +
            '<div class="tiny soft" style="margin-top:3px">Hand speed' + (fragile ? ' · red line = breaks the ' + esc(this.obj.label.toLowerCase()) : '') + '</div></div>' +
            '<span class="pill" id="hudHold">✋ open</span><span class="pill" id="hudMode">pointer</span></div>' +
          '<div class="teleop-actions">' + (ev ? '<button class="btn" id="watchBtn">▶ Watch the robot fail</button>' : '') + '<button class="btn primary" id="startBtn">Start</button>' +
            '<button class="btn" id="gripBtn" disabled>✊ Grab</button><button class="btn" id="precBtn" aria-pressed="false" title="Slow, careful movement (same as holding Shift)">🐢 Precision</button></div>' +
        '</div>' +
        '<div class="stack lg">' +
          '<div class="card"><div class="row">' + (b ? LW.kindPill(b) : '<span class="pill">Practice</span>') + '<span class="pill">' + (LW.OBJ_ICON[this.type] || '') + ' ' + esc(this.ep.skillName) + '</span></div>' +
            '<h2 style="margin-top:10px">' + esc(title) + '</h2>' +
            (b ? '<p class="small muted" style="margin-top:6px">' + esc(b.reason) + '</p>' : '') +
            '<div class="callout" style="margin-top:12px"><b>Task:</b> ' + (this.ep.init.held ? 'the robot is already holding the ' : 'grasp the ') + esc(this.obj.label.toLowerCase()) + ' and put it in the <b>' + esc(this.bin.label) + '</b>.' +
              (fragile ? ' <b>Fragile:</b> keep the speed bar under the red line. Turn on <b>🐢 Precision</b> (or hold <span class="kbd">Shift</span>) while carrying it.' : '') + '</div>' +
            '<div class="paylines" style="margin-top:12px">' +
              '<div><span class="muted">Time pay</span><span>' + LW.money(d.baseCentsPerHour) + '/hr, 1 min minimum</span></div>' +
              (b ? '<div><span class="muted">' + (b.kind === 'intervention' ? 'Takeover bounty' : 'Demo bounty') + '</span><span>' + LW.money(b.rateCents) + (levelMult > 1 ? ' × L' + d.level.level + ' ' + levelMult : '') + '</span></div>' : '<div><span class="muted">Bounty</span><span>none (practice)</span></div>') +
              '<div><span class="muted">Quality multiplier</span><span>×0.7 to ×1.3</span></div></div>' +
            '<div class="small muted" style="margin-top:12px;line-height:1.9"><b>Controls</b><br>Mouse: the hand follows your pointer · <b>click</b> to grasp / release<br>Touch: drag on the scene to steer · tap <b>Grab</b> / <b>Release</b><br>Keyboard: <span class="kbd">W</span><span class="kbd">A</span><span class="kbd">S</span><span class="kbd">D</span> or arrows · <span class="kbd">Space</span> grasp / release · <span class="kbd">Shift</span> precision</div>' +
          '</div>' +
          '<div class="card hidden" id="result"></div>' +
        '</div>' +
      '</section>';
    this.canvas = LW.$('#scene', this.main);
    this.scene = new LW.Scene(this.canvas);
    this.overlay = LW.$('#overlay', this.main);
    this.bind();
    this.render();
  };

  Console.prototype.bind = function () {
    const self = this;
    this.onKeyDown = function (e) {
      const k = KEYMAP[e.code];
      if (k) { self.keys[k] = true; if (self.phase === 'running' && k !== 'shift') e.preventDefault(); }
      if (e.code === 'Space' && self.phase === 'running') { e.preventDefault(); self.toggleGrip(); }
    };
    this.onKeyUp = function (e) { const k = KEYMAP[e.code]; if (k) self.keys[k] = false; };
    this.onBlur = function () { self.keys = {}; };
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    this.canvas.addEventListener('pointermove', function (e) { self.pointer = self.scene.toWorld(e.clientX, e.clientY); });
    this.canvas.addEventListener('pointerleave', function () { self.pointer = null; });
    this.canvas.addEventListener('pointercancel', function () { self.pointer = null; });
    this.canvas.addEventListener('pointerdown', function (e) {
      self.pointer = self.scene.toWorld(e.clientX, e.clientY);
      // Touch steers by dragging, so grasping uses the Grab button instead of taps.
      if (self.phase === 'running' && e.pointerType !== 'touch') { e.preventDefault(); self.toggleGrip(); }
    });
    LW.$('#startBtn', this.main).addEventListener('click', function () { self.start(); });
    LW.$('#gripBtn', this.main).addEventListener('click', function () { if (self.phase === 'running') self.toggleGrip(); });
    const prec = LW.$('#precBtn', this.main);
    prec.addEventListener('click', function () {
      self.precisionLatch = !self.precisionLatch;
      prec.setAttribute('aria-pressed', String(self.precisionLatch));
    });
    const watch = LW.$('#watchBtn', this.main);
    if (watch) watch.addEventListener('click', function () { self.watch(); });
  };

  Console.prototype.toggleGrip = function () { this.pendingGrip = this.state.held ? 2 : 1; };
  Console.prototype.precision = function () { return !!this.keys.shift || !!this.precisionLatch; };

  Console.prototype.computeAction = function () {
    const k = this.keys;
    const cap = this.precision() ? Sim.PRECISION : 1;
    const kx = (k.right ? 1 : 0) - (k.left ? 1 : 0), ky = (k.down ? 1 : 0) - (k.up ? 1 : 0);
    let ax = 0, ay = 0;
    this.inputMode = 'idle';
    if (kx || ky) {
      const n = Math.sqrt(kx * kx + ky * ky);
      ax = kx / n * cap; ay = ky / n * cap; this.inputMode = 'keyboard';
    } else if (this.pointer) {
      const dx = this.pointer.x - this.state.gx, dy = this.pointer.y - this.state.gy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 0.25) { const mag = Math.min(cap, d * 0.18); ax = dx / d * mag; ay = dy / d * mag; }
      this.inputMode = 'pointer';
    }
    const g = this.pendingGrip;
    this.pendingGrip = 0;
    return [ax, ay, g];
  };

  Console.prototype.render = function () {
    const s = this.state;
    const dx = s.ox - s.gx, dy = s.oy - s.gy;
    const t = s.t / Sim.HZ;
    this.scene.draw({
      type: this.type, gx: s.gx, gy: s.gy, ox: s.ox, oy: s.oy, held: s.held, trail: this.trail, targetBin: this.obj.bin,
      graspable: !s.held && !s.done && dx * dx + dy * dy <= Sim.GRASP_R * Sim.GRASP_R,
      speedRatio: s.speed / Sim.FRAGILE_V, broken: s.done && s.failure === 'broke_fragile',
      hud: { rec: this.phase === 'running', left: this.robotLabel(), right: 'link 20 Hz · t ' + t.toFixed(1) + 's' },
    });
    const sp = LW.$('#hudSpeed', this.main);
    if (sp) {
      sp.style.width = Math.min(100, s.speed / Sim.VMAX * 100).toFixed(1) + '%';
      const ratio = s.speed / Sim.FRAGILE_V;
      sp.className = this.obj.fragile && s.held ? (ratio > 1 ? 'bad' : ratio > 0.8 ? 'warn' : '') : '';
      LW.$('#hudTime', this.main).textContent = t.toFixed(1) + 's / ' + (Sim.T_MAX / Sim.HZ) + 's';
      LW.$('#hudHold', this.main).textContent = s.held ? '✊ holding' : '✋ open';
      LW.$('#hudMode', this.main).textContent = this.precision() ? 'precision' : (this.inputMode || 'pointer');
      const grip = LW.$('#gripBtn', this.main);
      grip.disabled = this.phase !== 'running';
      grip.textContent = s.held ? '✋ Release' : '✊ Grab';
    }
  };

  Console.prototype.setOverlay = function (html) {
    if (!this.overlay) return;
    this.overlay.parentElement.classList.toggle('hidden', !html);
    if (html) this.overlay.innerHTML = html;
  };

  Console.prototype.watch = async function () {
    if (this.phase !== 'ready') return;
    const self = this;
    this.phase = 'replaying';
    this.setOverlay(null);
    LW.$('#startBtn', this.main).disabled = true;
    try {
      if (!this.robotRun) this.robotRun = await LW.api.call('robotAttempt', { episodeId: this.ep.id });
      const r = this.robotRun;
      this.player = LW.playFrames(this.scene, this.type, r.frames, {
        ghost: true, handoverIndex: r.handoverIndex, outcome: r.outcome,
        hud: function (i) { return { rec: false, left: 'REPLAY · ' + r.event.robot + ' on policy v' + r.event.policyVersion, right: 't ' + (i / Sim.HZ).toFixed(1) + 's' }; },
      });
      const finished = await this.player.done;
      if (finished) {
        this.setOverlay('💥 ' + esc(LW.failLabel(r.outcome.failure)) + '<div class="small muted" style="margin-top:4px">You take over from the marked point</div>');
        await LW.sleep(1600);
      }
    } catch (e) { LW.fail(e); }
    if (this.phase !== 'replaying') return;
    this.phase = 'ready';
    this.setOverlay('Your turn. Press <b>Start</b> to take over');
    const btn = LW.$('#startBtn', this.main);
    if (btn) btn.disabled = false;
    self.render();
  };

  Console.prototype.start = async function () {
    if (this.phase !== 'ready') return;
    this.phase = 'countdown';
    LW.$('#startBtn', this.main).disabled = true;
    const w = LW.$('#watchBtn', this.main);
    if (w) w.disabled = true;
    this.canvas.focus();
    for (const n of ['3', '2', '1']) {
      this.setOverlay('<span style="font-size:34px">' + n + '</span>');
      await LW.sleep(420);
      if (this.phase !== 'countdown') return;
    }
    this.setOverlay(null);
    this.phase = 'running';
    this.last = performance.now();
    this.acc = 0;
    const self = this;
    this.frameFn = function (now) { self.frame(now); };
    this.raf = requestAnimationFrame(this.frameFn);
  };

  Console.prototype.frame = function (now) {
    if (this.phase !== 'running') return;
    let dt = now - this.last;
    this.last = now;
    if (dt > 250) dt = 250;
    this.acc += dt;
    const stepMs = 1000 / Sim.HZ;
    while (this.acc >= stepMs && !this.state.done) {
      const a = this.computeAction();
      const q = [Sim.quant(a[0]), Sim.quant(a[1]), a[2]];
      this.actions.push(q);
      Sim.step(this.state, q);
      this.trail.push([this.state.gx, this.state.gy]);
      if (this.trail.length > 60) this.trail.shift();
      this.acc -= stepMs;
    }
    this.render();
    if (this.state.done) this.finish();
    else this.raf = requestAnimationFrame(this.frameFn);
  };

  Console.prototype.finish = async function () {
    this.phase = 'submitting';
    const grip = LW.$('#gripBtn', this.main);
    if (grip) grip.disabled = true;
    const s = this.state;
    this.setOverlay((s.success ? '✅ Placed in the ' + esc(this.bin.label) : '❌ ' + esc(LW.failLabel(s.failure))) + '<div class="small muted" style="margin-top:4px"><span class="spinner" style="width:12px;height:12px;border-width:2px"></span> Re-simulating your ' + this.actions.length + ' actions to verify…</div>');
    let res;
    try {
      res = await LW.api.call('submitEpisode', {
        workerId: LW.me(), episodeId: this.ep.id, actions: Sim.encodeActions(this.actions),
        clientOutcome: { success: s.success, steps: s.t },
      });
    } catch (e) {
      LW.fail(e);
      this.setOverlay('Submission failed: ' + esc(e.message));
      return;
    }
    this.phase = 'done';
    this.setOverlay(s.success ? '✅ Verified and recorded' : '❌ ' + esc(LW.failLabel(s.failure)));
    this.showResult(res);
  };

  Console.prototype.showResult = function (res) {
    const ses = res.session, m = res.metrics, pay = ses.pay, b = res.bounty;
    const el = LW.$('#result', this.main);
    el.classList.remove('hidden');
    const statusText = {
      approved: 'Auto-approved. It\'s in the training set for the next model.',
      review: 'Sent to human review' + (ses.flags.length ? ' (' + ses.flags.join(', ').replace(/_/g, ' ') + ')' : ' (QA below the auto-approve bar)') + '. Bounty pay is pending until approved.',
      rejected: 'Not used for training (the task failed), but you were paid for your time.',
    }[ses.status];
    const metric = function (label, v) { return '<div class="metric"><span class="muted">' + label + '</span>' + LW.bar(v, LW.successClass(v)) + '<span class="right">' + Math.round(v * 100) + '</span></div>'; };
    const sameBountyOpen = b && b.status === 'open' && b.kind !== 'intervention';
    const nextHref = sameBountyOpen ? '#/teleop?bounty=' + encodeURIComponent(b.id) + '&n=' + Date.now() : '#/teleop?skill=' + ses.skill + '&n=' + Date.now();
    el.innerHTML = '<div class="card-head"><h2>' + (ses.outcome.success ? 'Nice work' : 'Attempt recorded') + '</h2>' + LW.statusPill(ses.status) + '</div>' +
      '<div class="callout ' + (res.verified ? 'neutral' : '') + '">' + (res.verified ? '🔒 Re-simulating your actions reproduced your result exactly (' + m.steps + ' steps).' : '⚠️ Re-simulating your actions didn\'t match what the client reported. Flagged for review.') + '</div>' +
      '<div style="margin-top:12px">' + metric('Efficiency', m.efficiency) + metric('Smoothness', m.smoothness) + metric('Safety margin', m.safety) +
      '<div class="metric"><b>QA score</b>' + LW.bar(m.qa, LW.successClass(m.qa)) + '<b class="right">' + Math.round(m.qa * 100) + '</b></div></div>' +
      '<div class="paylines" style="margin-top:12px">' +
        '<div><span>Time pay (' + LW.dur(ses.workSec || ses.activeSec) + ' session, ' + LW.dur(ses.activeSec) + ' hands-on)</span><span>' + LW.money(pay.baseCents) + '</span></div>' +
        '<div><span>Bounty' + (pay.levelMult > 1 ? ' (×' + pay.levelMult + ' level)' : '') + '</span><span>' + LW.money(pay.bountyCents) + '</span></div>' +
        '<div><span>Quality bonus (×' + ses.qa.multiplier + ')</span><span>' + LW.money(pay.qualityCents) + '</span></div>' +
        '<div class="total"><span>Total</span><span>' + LW.money(pay.totalCents) + '</span></div></div>' +
      '<p class="small muted" style="margin-top:10px">' + esc(statusText) + (ses.outcome.success && !pay.bountyLive && ses.kind !== 'practice' ? ' The bounty was already filled by someone else, so only time pay applies.' : '') + '</p>' +
      (ses.outcome.success ? '<p class="tiny soft" style="margin-top:6px">💡 Robots usually pick up a new skill from 2–3 good demos, and they copy your speed. Carrying fragile items well under the red line gives them a safety margin for real-world wobble.</p>' : '') +
      (b ? '<p class="small muted" style="margin-top:6px">Bounty: ' + (b.status === 'open' ? (b.unit === 'takeover' ? 'still open' : b.filled + ' / ' + b.target + ' demos') : 'now ' + esc(b.status)) + '</p>' : '') +
      '<div class="row" style="margin-top:12px"><a class="btn primary" href="' + nextHref + '">Next episode</a><a class="btn" href="#/teleop">All teleop tasks</a>' + (ses.status === 'approved' ? '<a class="btn ghost" href="#/lab">Retrain with my data →</a>' : '') + '</div>';
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  Console.prototype.destroy = function () {
    this.phase = 'destroyed';
    if (LW.activeConsole === this) LW.activeConsole = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.player) this.player.stop();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    if (this.scene) this.scene.destroy();
  };

  LW.pages.teleop = async function (main, params) {
    if (!params.bounty && !params.skill) return chooser(main);
    const data = await LW.api.call('issueEpisode', { workerId: LW.me(), bountyId: params.bounty || undefined, skill: params.skill || undefined });
    return new Console(main, data);
  };
})(window.LW);
