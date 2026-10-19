/* LoopWork: smart-glasses capture (on-device QA + consent + submission). */
(function (LW) {
  'use strict';
  const Sim = window.LoopSim;
  const Engine = window.LoopEngine;
  const esc = LW.esc;

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function gray(ctx, W, H) {
    const d = ctx.getImageData(0, 0, W, H).data;
    const g = new Float32Array(W * H);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    return g;
  }
  function mean(g) { let s = 0; for (let i = 0; i < g.length; i++) s += g[i]; return s / g.length; }
  function lapVar(g, W, H) {
    let s = 0, s2 = 0, n = 0;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - W] - g[i + W];
      s += l; s2 += l * l; n++;
    }
    const m = s / n;
    return s2 / n - m * m;
  }
  function absDiff(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }
  /** Pixelated preview: the only imagery that leaves the device in this prototype. */
  function redactedThumb(source) {
    const small = document.createElement('canvas');
    small.width = 24; small.height = 14;
    small.getContext('2d').drawImage(source, 0, 0, 24, 14);
    const out = document.createElement('canvas');
    out.width = 120; out.height = 70;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, 120, 70);
    return out.toDataURL('image/jpeg', 0.6);
  }
  function seek(video, t) {
    return new Promise(function (resolve) {
      let done = false;
      const finish = function () { if (done) return; done = true; video.removeEventListener('seeked', finish); resolve(); };
      video.addEventListener('seeked', finish);
      setTimeout(finish, 3000);
      video.currentTime = t;
    });
  }

  async function analyzeFile(file, onProgress) {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.preload = 'auto'; video.src = url;
    try {
      await new Promise(function (res, rej) {
        video.onloadedmetadata = res;
        video.onerror = function () { rej(new Error('This browser cannot decode that file. Try an MP4 (H.264) or WebM clip.')); };
      });
      let duration = video.duration;
      if (!isFinite(duration)) { await seek(video, 1e7); duration = video.duration; }
      if (!isFinite(duration) || duration <= 0) throw new Error('Could not read the clip duration.');
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) throw new Error('No video track found in that file.');
      const W = 160, H = Math.max(1, Math.round(160 * vh / vw));
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const N = 10;
      let bright = 0, lap = 0, motion = 0;
      const thumbs = [];
      for (let i = 0; i < N; i++) {
        const t = Math.min(Math.max(0, duration - 0.15), duration * (i + 0.5) / N);
        await seek(video, t);
        ctx.drawImage(video, 0, 0, W, H);
        const g1 = gray(ctx, W, H);
        if ((i === 1 || i === 4 || i === 6 || i === 8) && thumbs.length < 4) thumbs.push(redactedThumb(video));
        await seek(video, Math.min(Math.max(0, duration - 0.05), t + 1 / 15));
        ctx.drawImage(video, 0, 0, W, H);
        const g2 = gray(ctx, W, H);
        bright += mean(g1); lap += lapVar(g1, W, H); motion += absDiff(g1, g2);
        onProgress((i + 1) / N);
      }
      return {
        source: 'upload', fileName: file.name, durationSec: duration, width: vw, height: vh, frames: N * 2,
        brightness: bright / N, sharpness: clamp(Math.sqrt(lap / N) * 4, 0, 100), stability: clamp(1 - (motion / N) / 25, 0, 1), thumbs: thumbs,
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function captureCamera(seconds, videoEl, onProgress) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Camera access is not available in this browser.');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    try {
      videoEl.srcObject = stream;
      await videoEl.play();
      const W = 160, H = 90;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const samples = Math.round(seconds * 4);
      let bright = 0, lap = 0, motion = 0, prev = null, n = 0;
      const thumbs = [];
      for (let i = 0; i < samples; i++) {
        await LW.sleep(250);
        ctx.drawImage(videoEl, 0, 0, W, H);
        const g = gray(ctx, W, H);
        bright += mean(g); lap += lapVar(g, W, H);
        if (prev) { motion += absDiff(prev, g); n++; }
        prev = g;
        if (i % Math.max(1, Math.floor(samples / 4)) === 1 && thumbs.length < 4) thumbs.push(redactedThumb(videoEl));
        onProgress((i + 1) / samples);
      }
      return {
        source: 'camera', fileName: null, durationSec: seconds, width: videoEl.videoWidth, height: videoEl.videoHeight, frames: samples,
        brightness: bright / samples, sharpness: clamp(Math.sqrt(lap / samples) * 4, 0, 100), stability: clamp(1 - (motion / Math.max(1, n)) / 25, 0, 1), thumbs: thumbs,
      };
    } finally {
      stream.getTracks().forEach(function (t) { t.stop(); });
      videoEl.srcObject = null;
    }
  }

  function simulateShift(minutes, device) {
    const r = Math.random;
    const presets = {
      glasses: { w: 1920, h: 1080, b: [110, 140], s: [60, 90], st: [0.72, 0.92] },
      phone: { w: 1280, h: 720, b: [105, 145], s: [50, 80], st: [0.6, 0.85] },
      lowlight: { w: 1920, h: 1080, b: [35, 60], s: [22, 42], st: [0.55, 0.8] },
    };
    const p = presets[device] || presets.glasses;
    const span = function (a) { return a[0] + r() * (a[1] - a[0]); };
    return { source: 'simulated', fileName: null, durationSec: minutes * 60, width: p.w, height: p.h, frames: 0, brightness: span(p.b), sharpness: span(p.s), stability: span(p.st), thumbs: [] };
  }

  LW.pages.glasses = async function (main, params) {
    const meId = LW.me();
    const me = LW.workerById(meId);
    if (me && me.modes.indexOf('glasses') < 0) {
      main.innerHTML = '<section class="card"><h2>Smart-glasses capture</h2><p class="muted" style="margin-top:8px">' + esc(me.name) + ' is enrolled for teleoperation only. Switch "Acting as" to <b>You</b>, Maria, Tom, Aisha, Lucas or Hana.</p></section>';
      return null;
    }
    const data = await LW.api.call('bounties', { workerId: meId });
    const caps = data.bounties.filter(function (b) { return b.mode === 'glasses'; });
    const st = { bountyId: params.bounty || (caps[0] ? caps[0].id : ''), skill: 'sort_laundry', source: 'simulated', media: null, busy: false };
    if (st.bountyId && !caps.some(function (b) { return b.id === st.bountyId; })) st.bountyId = caps[0] ? caps[0].id : '';
    let cancelled = false;

    main.innerHTML =
      '<section class="grid wide-right">' +
        '<div class="card stack lg">' +
          '<div><div class="eyebrow">Smart-glasses capture</div><h2>Earn while you work</h2><p class="small muted" style="margin-top:6px">Record real tasks from your point of view. Footage is analysed on this device: only quality metrics and pixelated previews are uploaded. In production, hand and object trajectories are extracted on-device and retargeted to the robot.</p></div>' +
          '<div><div class="row"><span class="step-num">1</span><b>What are you capturing?</b></div>' +
            '<select id="bountySel" style="width:100%;margin-top:8px">' + caps.map(function (b) {
              return '<option value="' + esc(b.id) + '" ' + (b.id === st.bountyId ? 'selected' : '') + '>Bounty: ' + esc(b.skillName) + ' (+' + LW.money(b.rateCents) + '/hr bonus, ' + Math.round(b.filled) + '/' + b.target + ' min)</option>';
            }).join('') + '<option value="" ' + (!st.bountyId ? 'selected' : '') + '>No bounty: open capture (base pay only)</option></select>' +
            '<select id="skillSel" style="width:100%;margin-top:8px" class="' + (st.bountyId ? 'hidden' : '') + '">' + Object.keys(Sim.SKILLS).map(function (s) { return '<option value="' + s + '">' + esc(Sim.SKILLS[s].name) + ' (' + esc(Sim.SKILLS[s].setting) + ')</option>'; }).join('') + '</select>' +
            '<p class="tiny soft" id="bountyReason" style="margin-top:6px"></p></div>' +
          '<div><div class="row"><span class="step-num">2</span><b>Footage source</b></div><div class="source-grid" style="margin-top:8px">' +
            '<button class="source" data-src="upload"><b>📁 Upload a clip</b><div class="tiny soft">From glasses or a phone (MP4 / WebM)</div></button>' +
            '<button class="source" data-src="camera"><b>📷 This device\'s camera</b><div class="tiny soft">10-second live capture demo</div></button>' +
            '<button class="source on" data-src="simulated"><b>🕶️ Simulated shift</b><div class="tiny soft">Pretend you wore glasses at work</div></button>' +
          '</div>' +
          '<div id="srcPanel" style="margin-top:10px"></div></div>' +
          '<div><div class="row"><span class="step-num">3</span><b>Consent &amp; privacy</b></div>' +
            '<input type="text" id="workplace" placeholder="Workplace (e.g. Harbourside Hotel, Sydney)" style="width:100%;margin-top:8px">' +
            '<label class="check"><input type="checkbox" data-c="siteConsent"><span>I have permission to record at this workplace <span class="tiny soft">(site agreement or manager approval)</span></span></label>' +
            '<label class="check"><input type="checkbox" data-c="bystanderNotice"><span>People around me were told, and the recording light was on</span></label>' +
            '<label class="check"><input type="checkbox" data-c="privacyZones"><span>I avoided privacy zones (bathrooms, change rooms, screens with personal data)</span></label>' +
            '<label class="check"><input type="checkbox" data-c="audio"><span>Include audio narration <span class="tiny soft">(optional, off by default)</span></span></label>' +
            '<p class="tiny soft">Faces and screens are always blurred on-device. You can opt out of future training at any time in the Worker app.</p></div>' +
        '</div>' +
        '<div class="stack lg">' +
          '<div class="card"><div class="card-head"><h2><span class="step-num">4</span> On-device quality check</h2><span class="small muted" id="qaHint">no footage yet</span></div><div id="qaPanel"><div class="empty">Choose a source and capture or analyse footage to see its QA score and estimated pay.</div></div>' +
          '<div class="row" style="margin-top:14px"><button class="btn primary" id="submitBtn" disabled>Submit footage</button><span class="small muted" id="submitHint">Complete the consent checklist to submit</span></div></div>' +
          '<div class="card hidden" id="glassResult"></div>' +
        '</div>' +
      '</section>';

    const bountySel = LW.$('#bountySel', main), skillSel = LW.$('#skillSel', main);
    function bounty() { return caps.find(function (b) { return b.id === st.bountyId; }) || null; }
    function consent() {
      const c = {};
      LW.$$('[data-c]', main).forEach(function (el) { c[el.getAttribute('data-c')] = el.checked; });
      return c;
    }
    function updateBountyInfo() {
      const b = bounty();
      skillSel.classList.toggle('hidden', !!b);
      LW.$('#bountyReason', main).textContent = b ? b.reason : 'Open capture: paid at the base rate for verified footage.';
    }
    function renderSource() {
      LW.$$('.source', main).forEach(function (el) { el.classList.toggle('on', el.getAttribute('data-src') === st.source); });
      const p = LW.$('#srcPanel', main);
      if (st.source === 'upload') {
        p.innerHTML = '<input type="file" id="fileIn" accept="video/*"><div class="tiny soft" style="margin-top:6px">The video never leaves this browser. It is decoded locally to measure exposure, sharpness and stability.</div><div id="progress" style="margin-top:8px"></div>';
        LW.$('#fileIn', p).addEventListener('change', async function (e) {
          const f = e.target.files[0];
          if (!f) return;
          await runAnalysis(function (prog) { return analyzeFile(f, prog); });
        });
      } else if (st.source === 'camera') {
        p.innerHTML = '<div class="row"><button class="btn" id="camBtn">Start 10s capture</button><span class="tiny soft">Your browser will ask for camera permission. Nothing is uploaded.</span></div><video id="camVideo" muted playsinline style="width:100%;max-height:200px;border-radius:12px;margin-top:8px;background:var(--cp-surface-soft)"></video><div id="progress" style="margin-top:8px"></div>';
        LW.$('#camBtn', p).addEventListener('click', async function () {
          await runAnalysis(function (prog) { return captureCamera(10, LW.$('#camVideo', p), prog); });
        });
      } else {
        p.innerHTML = '<div class="row"><select id="simMin"><option value="5">5 min</option><option value="15" selected>15 min</option><option value="30">30 min</option><option value="60">60 min</option></select>' +
          '<select id="simDev"><option value="glasses">Smart glasses (1080p)</option><option value="phone">Phone head-mount (720p)</option><option value="lowlight">Smart glasses, dim kitchen</option></select>' +
          '<button class="btn" id="simBtn">Simulate shift</button></div><div id="progress" style="margin-top:8px"></div>';
        LW.$('#simBtn', p).addEventListener('click', async function () {
          const mins = Number(LW.$('#simMin', p).value), dev = LW.$('#simDev', p).value;
          await runAnalysis(async function (prog) { for (let i = 1; i <= 5; i++) { await LW.sleep(110); prog(i / 5); } return simulateShift(mins, dev); });
        });
      }
    }
    async function runAnalysis(fn) {
      if (st.busy) return;
      st.busy = true;
      const prog = LW.$('#progress', main);
      try {
        st.media = await fn(function (v) { if (prog && !cancelled) prog.innerHTML = LW.bar(v) + '<div class="tiny soft" style="margin-top:4px">Analysing on-device… ' + Math.round(v * 100) + '%</div>'; });
        if (prog && !cancelled) prog.innerHTML = '<div class="tiny soft">✓ Analysis complete</div>';
        renderQa();
      } catch (e) {
        if (prog && !cancelled) prog.innerHTML = '';
        LW.fail(e);
      } finally { st.busy = false; }
    }
    function renderQa() {
      const m = st.media;
      const panel = LW.$('#qaPanel', main);
      if (!m) return;
      const qa = Engine._internals.glassesQa({ width: m.width, height: m.height, brightness: m.brightness, sharpness: m.sharpness, stability: m.stability, durationSec: m.durationSec });
      const b = bounty();
      const cfg = LW.cfg || { glassesBaseCentsPerHour: 600 };
      const hours = m.durationSec / 3600;
      const base = Math.max(1, Math.round(cfg.glassesBaseCentsPerHour * hours));
      const bonus = b ? Math.round(b.rateCents * hours) : 0;
      const quality = Math.round(bonus * (qa.multiplier - 1));
      const row = function (label, v, note) { return '<div class="metric"><span class="muted">' + label + '</span>' + LW.bar(v, LW.successClass(v)) + '<span class="right">' + Math.round(v * 100) + '</span></div>' + (note ? '<div class="tiny soft" style="margin:-2px 0 4px 118px">' + note + '</div>' : ''); };
      LW.$('#qaHint', main).textContent = (m.source === 'upload' ? (m.fileName || 'clip') : m.source === 'camera' ? 'camera capture' : 'simulated shift') + ' · ' + LW.dur(m.durationSec);
      panel.innerHTML = (m.thumbs && m.thumbs.length ? '<div class="thumbs">' + m.thumbs.map(function (t) { return '<img alt="Redacted preview" src="' + t + '">'; }).join('') + '</div><div class="tiny soft" style="margin:4px 0 10px">Redacted previews (pixelated on-device), the only imagery uploaded</div>' : '') +
        row('Resolution', qa.resolution, m.width + '×' + m.height) + row('Exposure', qa.exposure, 'mean luma ' + Math.round(m.brightness)) + row('Sharpness', qa.sharpness) + row('Stability', qa.stability) + row('Coverage', qa.coverage, LW.dur(m.durationSec) + ' of footage') +
        '<div class="metric"><b>QA score</b>' + LW.bar(qa.score, LW.successClass(qa.score)) + '<b class="right">' + Math.round(qa.score * 100) + '</b></div>' +
        '<div class="paylines" style="margin-top:10px"><div><span>Base (' + LW.money(cfg.glassesBaseCentsPerHour) + '/hr)</span><span>' + LW.money(base) + '</span></div>' +
        '<div><span>Bounty bonus' + (b ? ' (+' + LW.money(b.rateCents) + '/hr)' : '') + '</span><span>' + LW.money(bonus) + '</span></div>' +
        '<div><span>Quality multiplier ×' + qa.multiplier + '</span><span>' + LW.money(quality) + '</span></div>' +
        '<div class="total"><span>Estimated pay</span><span>' + LW.money(base + bonus + quality) + '</span></div></div>' +
        (qa.score < 0.5 ? '<p class="small" style="color:var(--cp-warning);margin-top:8px">Below the auto-approve bar: a reviewer will check this one. Better light and a steadier head help.</p>' : '');
      updateSubmit();
    }
    function updateSubmit() {
      const c = consent();
      const ok = c.siteConsent && c.bystanderNotice && c.privacyZones;
      const btn = LW.$('#submitBtn', main);
      btn.disabled = !(ok && st.media) || st.busy;
      LW.$('#submitHint', main).textContent = !st.media ? 'Capture or analyse footage first' : !ok ? 'Complete the consent checklist to submit' : 'Ready. Only metrics and redacted previews are sent';
    }

    bountySel.addEventListener('change', function () { st.bountyId = bountySel.value; updateBountyInfo(); renderQa(); });
    main.addEventListener('click', function (e) {
      const s = e.target.closest('[data-src]');
      if (s) { st.source = s.getAttribute('data-src'); renderSource(); }
    });
    main.addEventListener('change', function (e) { if (e.target.closest('[data-c]')) updateSubmit(); });
    LW.$('#submitBtn', main).addEventListener('click', function (e) {
      const btn = e.currentTarget;
      LW.busy(btn, async function () {
        const m = st.media;
        const res = await LW.api.call('submitGlasses', {
          workerId: meId, bountyId: st.bountyId || undefined, skill: st.bountyId ? undefined : skillSel.value,
          consent: consent(), workplace: LW.$('#workplace', main).value || undefined,
          media: { source: m.source, durationSec: m.durationSec, width: m.width, height: m.height, brightness: m.brightness, sharpness: m.sharpness, stability: m.stability, frames: m.frames, fileName: m.fileName, thumbs: m.thumbs },
        });
        const s = res.session;
        const out = LW.$('#glassResult', main);
        out.classList.remove('hidden');
        out.innerHTML = '<div class="card-head"><h2>Footage submitted</h2>' + LW.statusPill(s.status) + '</div>' +
          '<div class="paylines"><div><span>Base pay</span><span>' + LW.money(s.pay.baseCents) + '</span></div><div><span>Bounty bonus</span><span>' + LW.money(s.pay.bountyCents) + '</span></div><div><span>Quality bonus</span><span>' + LW.money(s.pay.qualityCents) + '</span></div><div class="total"><span>Total</span><span>' + LW.money(s.pay.totalCents) + '</span></div></div>' +
          '<div class="callout" style="margin-top:12px">🦾 Your hand trajectories were retargeted into <b>' + s.retarget.yielded + ' robot demonstrations</b> for "' + esc(s.skillName) + '" (retargeting is simulated in this prototype).</div>' +
          '<p class="small muted" style="margin-top:8px">' + (s.status === 'approved' ? 'Approved automatically. These demos join the next training run.' : 'Queued for human review. Bonus pay is pending until approved.') + '</p>' +
          '<div class="row" style="margin-top:10px"><a class="btn" href="#/worker">Back to bounties</a><a class="btn ghost" href="#/lab">Retrain with this data →</a></div>';
        st.media = null;
        LW.$('#qaPanel', main).innerHTML = '<div class="empty">Submitted ✓ Capture more footage any time.</div>';
        updateSubmit();
        LW.toast('🕶️ Footage accepted: ' + LW.money(s.pay.totalCents) + ' (' + s.status + ')', 'ok');
      });
    });
    updateBountyInfo();
    renderSource();
    return { destroy: function () { cancelled = true; } };
  };
})(window.LW);
