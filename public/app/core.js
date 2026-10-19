/* LoopWork web client: core utilities, API client, router, UI primitives, charts. */
window.LW = window.LW || {};
(function (LW) {
  'use strict';
  const Sim = window.LoopSim;
  const Engine = window.LoopEngine;

  // ------------------------------------------------------------ utils
  LW.$ = function (sel, root) { return (root || document).querySelector(sel); };
  LW.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  LW.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  LW.money = function (c, digits) {
    const v = (c || 0) / 100;
    const d = digits == null ? (Math.abs(v) >= 1000 ? 0 : 2) : digits;
    return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  };
  LW.pct = function (x) { return x == null ? '–' : Math.round(x * 100) + '%'; };
  LW.ago = function (ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  };
  LW.dur = function (sec) {
    if (sec < 60) return sec.toFixed(1) + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ' + String(Math.round(sec % 60)).padStart(2, '0') + 's';
    return (sec / 3600).toFixed(1) + 'h';
  };
  LW.cssVar = function (name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); };
  LW.sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  LW.SKILL_COLOR = { stock_shelf: '--cp-warning', handle_glassware: '--cp-link', sort_laundry: '--cp-accent', load_plates: '--cp-success' };
  LW.FAIL_COLOR = { broke_fragile: '--cp-danger', wrong_bin: '--cp-warning', dropped: '--cp-link', timeout: '--cp-text-soft' };
  LW.KIND_COLOR = { base: '--cp-text-soft', bounty: '--cp-accent', quality: '--cp-warning', royalty: '--cp-success' };
  LW.KIND_LABEL = { base: 'Time pay', bounty: 'Bounties', quality: 'Quality bonus', royalty: 'Data dividends', payout: 'Payout' };
  LW.OBJ_ICON = { box: '📦', glass: '🍷', towel: '🧺', plate: '🍽️' };
  LW.skillName = function (id) { return Sim.SKILLS[id] ? Sim.SKILLS[id].name : id; };
  LW.failLabel = function (f) { return Sim.FAILURES[f] ? Sim.FAILURES[f].label : f; };

  // ------------------------------------------------------------ API: real server, or the same engine in-browser
  const LOCAL_KEY = 'loopwork-offline-state-v1';
  LW.api = {
    mode: null,
    hosted: false, // static build (e.g. GitHub Pages): never look for a server
    box: null,
    init: async function () {
      const meta = document.querySelector('meta[name="loopwork-mode"]');
      this.hosted = !!(meta && meta.getAttribute('content') === 'static');
      const forceLocal = this.hosted || new URLSearchParams(location.search).has('offline');
      if (!forceLocal && /^https?:$/.test(location.protocol)) {
        try {
          const r = await fetch('api/health', { cache: 'no-store' });
          const h = r.ok ? await r.json() : null;
          if (h && h.ok && h.schema === Engine.SCHEMA) { this.mode = 'server'; return; }
        } catch (e) { /* fall through to the in-browser engine */ }
      }
      this.mode = 'offline';
      let state = null;
      try {
        const raw = localStorage.getItem(LOCAL_KEY);
        if (raw) { const s = JSON.parse(raw); if (s && s.schema === Engine.SCHEMA) state = s; }
      } catch (e) { state = null; }
      this.box = { state: state || Engine.createState({}), rt: Engine.createRuntime() };
      this.persist();
    },
    persist: function () {
      try {
        localStorage.setItem(LOCAL_KEY, JSON.stringify(this.box.state));
        this.persistError = null;
      } catch (e) {
        if (!this.persistError) LW.toast('⚠️ This browser won\'t let LoopWork save (storage is full or blocked), so progress will be lost when you close the tab. Ops &amp; pay → Reset demo frees space.', 'bad', 9000);
        this.persistError = e.message || String(e);
      }
    },
    local: function (op, args) {
      const out = Engine.dispatch(this.box, op, JSON.parse(JSON.stringify(args || {})), { now: Date.now(), trusted: false });
      if (Engine.isMutating(op)) this.persist();
      return JSON.parse(JSON.stringify(out));
    },
    call: async function (op, args) {
      if (this.mode === 'server') {
        const req = Engine.buildRequest(op, args || {});
        // Relative to the page, so the server also works behind a reverse-proxy sub-path.
        const res = await fetch(req.url.replace(/^\//, ''), {
          method: req.method, cache: 'no-store',
          headers: req.body ? { 'Content-Type': 'application/json' } : {},
          body: req.body ? JSON.stringify(req.body) : undefined,
        });
        const data = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(data.error || 'Request failed (' + res.status + ')');
        return data;
      }
      if (op === 'runCycle') {
        // One cycle at a time, yielding between them, so animations stay smooth in the browser.
        const n = Math.max(1, Math.min(10, Math.round(Number(args && args.cycles) || 1)));
        let out = null;
        for (let i = 0; i < n; i++) {
          await LW.sleep(30);
          out = this.local(op, Object.assign({}, args, { cycles: 1 }));
        }
        return out;
      }
      await LW.sleep(0);
      return this.local(op, args);
    },
  };

  // ------------------------------------------------------------ acting-as contributor
  LW.me = function () {
    try { return localStorage.getItem('loopwork-worker') || 'w_you'; } catch (e) { return 'w_you'; }
  };
  LW.setMe = function (id) { try { localStorage.setItem('loopwork-worker', id); } catch (e) { /* ignore */ } };
  LW.workers = [];
  LW.workerById = function (id) { return LW.workers.find(function (w) { return w.id === id; }) || null; };

  // ------------------------------------------------------------ toasts & modal
  LW.toast = function (msg, kind, ms) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.innerHTML = msg;
    LW.$('#toasts').appendChild(el);
    setTimeout(function () { el.remove(); }, ms || 4200);
  };
  LW.fail = function (e) { LW.toast(LW.esc(e && e.message ? e.message : String(e)), 'bad', 5200); };

  LW.modal = function (opts) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = '<div class="modal ' + (opts.wide ? 'wide' : '') + '" role="dialog" aria-modal="true"><div class="modal-head"><h2>' + LW.esc(opts.title) + '</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div><div class="modal-body">' + (opts.body || '') + '</div></div>';
    document.body.appendChild(back);
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      back.remove();
      document.removeEventListener('keydown', onKey);
      if (opts.onClose) opts.onClose();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    back.addEventListener('click', function (e) { if (e.target === back || e.target.closest('[data-close]')) close(); });
    document.addEventListener('keydown', onKey);
    return { el: back.querySelector('.modal-body'), close: close };
  };

  LW.busy = async function (btn, fn) {
    const label = btn ? btn.innerHTML : null;
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px"></span> Working…'; }
    try { return await fn(); }
    catch (e) { LW.fail(e); return null; }
    finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = label; } }
  };

  // ------------------------------------------------------------ small components
  LW.bar = function (value, cls) {
    const v = Math.max(0, Math.min(1, value || 0));
    return '<div class="bar ' + (cls || '') + '"><span style="width:' + (v * 100).toFixed(1) + '%"></span></div>';
  };
  LW.successClass = function (v) { return v == null ? '' : v >= 0.9 ? 'ok' : v >= 0.6 ? 'warn' : 'bad'; };
  LW.statusPill = function (status) {
    const map = { approved: 'ok', review: 'warn', rejected: 'bad', open: 'accent', filled: 'ok', closed: '', expired: '', deployed: 'ok', candidate: 'link', blocked: 'bad', retired: '', pending: 'warn', available: 'ok', paid: '', void: 'bad' };
    return '<span class="pill ' + (map[status] || '') + '">' + LW.esc(status) + '</span>';
  };
  LW.kindPill = function (b) {
    if (b.kind === 'intervention') return '<span class="pill accent">Takeover</span>';
    if (b.kind === 'capture') return '<span class="pill">🕶️ Glasses</span>';
    return '<span class="pill">🎮 Teleop demos</span>';
  };
  LW.unitLabel = function (u) { return u === 'hour' ? '/hr bonus' : u === 'takeover' ? '/takeover' : '/demo'; };

  // ------------------------------------------------------------ SVG charts (theme-aware via CSS variables)
  function niceX(i, n, w, padL, padR) { return padL + (n <= 1 ? (w - padL - padR) / 2 : i * (w - padL - padR) / (n - 1)); }

  LW.lineChart = function (opts) {
    const W = 560, H = opts.height || 220, padL = 36, padR = 14, padT = 12, padB = 26;
    const n = opts.labels.length;
    const y = function (v) { return padT + (1 - v) * (H - padT - padB); };
    let s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + LW.esc(opts.aria || 'line chart') + '">';
    [0, 0.25, 0.5, 0.75, 1].forEach(function (g) {
      s += '<line class="grid-line" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(g) + '" y2="' + y(g) + '"/>';
      s += '<text x="' + (padL - 6) + '" y="' + (y(g) + 4) + '" text-anchor="end">' + Math.round(g * 100) + '%</text>';
    });
    const step = Math.max(1, Math.ceil(n / 12));
    opts.labels.forEach(function (lab, i) {
      if (i % step === 0 || i === n - 1) s += '<text x="' + niceX(i, n, W, padL, padR) + '" y="' + (H - 8) + '" text-anchor="middle">' + LW.esc(lab) + '</text>';
    });
    opts.series.forEach(function (ser) {
      const pts = [];
      ser.values.forEach(function (v, i) { if (v != null) pts.push([niceX(i, n, W, padL, padR), y(v)]); });
      if (!pts.length) return;
      const color = 'var(' + ser.color + ')';
      if (pts.length > 1) s += '<polyline fill="none" style="stroke:' + color + '" stroke-width="' + (ser.width || 2.5) + '" stroke-linejoin="round" stroke-linecap="round" ' + (ser.dashed ? 'stroke-dasharray="6 5"' : '') + ' points="' + pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ') + '"/>';
      pts.forEach(function (p) { s += '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3.2" style="fill:' + color + '"/>'; });
    });
    s += '</svg>';
    s += '<div class="legend">' + opts.series.map(function (ser) { return '<span><i style="background:var(' + ser.color + ')"></i>' + LW.esc(ser.name) + '</span>'; }).join('') + '</div>';
    return s;
  };

  LW.stackedBars = function (opts) {
    const W = 560, H = opts.height || 220, padL = 36, padR = 10, padT = 12, padB = 26;
    const n = opts.labels.length;
    const totals = opts.labels.map(function (_, i) { return opts.stacks.reduce(function (a, st) { return a + (st.values[i] || 0); }, 0); });
    const max = Math.max(1, opts.max || Math.max.apply(null, totals.concat([1])));
    const bw = Math.min(34, (W - padL - padR) / Math.max(1, n) * 0.65);
    const y = function (v) { return padT + (1 - v / max) * (H - padT - padB); };
    let s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + LW.esc(opts.aria || 'bar chart') + '">';
    [0, 0.5, 1].forEach(function (g) {
      const v = g * max;
      s += '<line class="grid-line" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>';
      s += '<text x="' + (padL - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + (opts.format ? opts.format(v) : Math.round(v)) + '</text>';
    });
    const step = Math.max(1, Math.ceil(n / 14));
    opts.labels.forEach(function (lab, i) {
      const cx = padL + (i + 0.5) * (W - padL - padR) / Math.max(1, n);
      let acc = 0;
      opts.stacks.forEach(function (st) {
        const v = st.values[i] || 0;
        if (v <= 0) return;
        const y0 = y(acc), y1 = y(acc + v);
        s += '<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + y1.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(0.5, y0 - y1).toFixed(1) + '" rx="2" style="fill:var(' + st.color + ')"><title>' + LW.esc(lab + ' · ' + st.name + ': ' + (opts.format ? opts.format(v) : v)) + '</title></rect>';
        acc += v;
      });
      if (i % step === 0 || i === n - 1) s += '<text x="' + cx.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">' + LW.esc(lab) + '</text>';
    });
    s += '</svg><div class="legend">' + opts.stacks.map(function (st) { return '<span><i style="background:var(' + st.color + ')"></i>' + LW.esc(st.name) + '</span>'; }).join('') + '</div>';
    return s;
  };

  LW.hStacked = function (rows, kinds) {
    const max = Math.max(1, Math.max.apply(null, rows.map(function (r) { return kinds.reduce(function (a, k) { return a + Math.max(0, r.values[k] || 0); }, 0); })));
    let s = '<div class="stack">';
    rows.forEach(function (r) {
      const total = kinds.reduce(function (a, k) { return a + Math.max(0, r.values[k] || 0); }, 0);
      s += '<div><div class="row between small"><span>' + r.label + '</span><b>' + LW.money(total) + '</b></div><div class="bar" style="display:flex;height:10px">';
      kinds.forEach(function (k) {
        const v = Math.max(0, r.values[k] || 0);
        if (v > 0) s += '<span title="' + LW.esc(LW.KIND_LABEL[k] + ': ' + LW.money(v)) + '" style="border-radius:0;width:' + (v / max * 100).toFixed(2) + '%;background:var(' + LW.KIND_COLOR[k] + ')"></span>';
      });
      s += '</div></div>';
    });
    s += '</div><div class="legend">' + kinds.map(function (k) { return '<span><i style="background:var(' + LW.KIND_COLOR[k] + ')"></i>' + LW.KIND_LABEL[k] + '</span>'; }).join('') + '</div>';
    return s;
  };

  LW.sparkBars = function (values, color) {
    const max = Math.max(1, Math.max.apply(null, values));
    const W = 240, H = 46, n = values.length, bw = W / Math.max(1, n) * 0.7;
    let s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">';
    values.forEach(function (v, i) {
      const h = Math.max(v > 0 ? 2 : 0.5, v / max * (H - 4));
      s += '<rect x="' + (i * W / n + (W / n - bw) / 2).toFixed(1) + '" y="' + (H - h).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2" style="fill:var(' + (color || '--cp-success') + ')"/>';
    });
    return s + '</svg>';
  };

  // ------------------------------------------------------------ router
  LW.pages = {};
  let current = null;
  LW.route = function () {
    const h = location.hash.replace(/^#\/?/, '');
    const parts = h.split('?');
    const params = {};
    new URLSearchParams(parts[1] || '').forEach(function (v, k) { params[k] = v; });
    return { name: parts[0] || 'overview', params: params };
  };
  LW.render = async function () {
    const r = LW.route();
    const page = LW.pages[r.name] || LW.pages.overview;
    if (current && current.destroy) { try { current.destroy(); } catch (e) { /* ignore */ } }
    current = null;
    LW.$$('#tabs a').forEach(function (a) { a.classList.toggle('active', a.getAttribute('data-route') === (LW.pages[r.name] ? r.name : 'overview')); });
    // Fresh container per render so page-level event listeners never accumulate.
    const old = LW.$('#main');
    const main = old.cloneNode(false);
    old.replaceWith(main);
    main.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
    try {
      current = (await page(main, r.params)) || null;
    } catch (e) {
      main.innerHTML = '<div class="card"><h2>Something went wrong</h2><p class="muted" style="margin-top:8px">' + LW.esc(e.message) + '</p></div>';
      console.error(e);
    }
  };
  LW.refresh = function () { return LW.render(); };
})(window.LW);
