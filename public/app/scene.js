/* LoopWork scene renderer: draws the shared sim world on a canvas (teleop + replays). */
(function (LW) {
  'use strict';
  const Sim = window.LoopSim;

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function circle(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); }
  function text(ctx, str, x, y, size, color, align, weight) {
    ctx.font = (weight || 500) + ' ' + size + 'px "Segoe UI", Aptos, Calibri, sans-serif';
    ctx.fillStyle = color;
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(str, x, y);
  }

  function Scene(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts || {};
    this.colors = null;
    this.last = null;
    const self = this;
    this._onResize = function () { self.resize(); if (self.last) self.draw(self.last); };
    window.addEventListener('resize', this._onResize);
    this._themeObs = new MutationObserver(function () { self.colors = null; if (self.last) self.draw(self.last); });
    this._themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.resize();
  }
  Scene.prototype.destroy = function () {
    window.removeEventListener('resize', this._onResize);
    this._themeObs.disconnect();
  };
  Scene.prototype.resize = function () {
    const parentW = this.canvas.parentElement ? this.canvas.parentElement.clientWidth : 0;
    const w = Math.max(280, parentW || this.canvas.getBoundingClientRect().width || 640);
    const dpr = window.devicePixelRatio || 1;
    this.cssW = w;
    this.cssH = w * Sim.WORLD.h / Sim.WORLD.w;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = this.cssH + 'px';
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    this.dpr = dpr;
    this.scale = this.canvas.width / Sim.WORLD.w;
    this.colors = null;
  };
  Scene.prototype.toWorld = function (clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (clientX - r.left) / r.width * Sim.WORLD.w, y: (clientY - r.top) / r.height * Sim.WORLD.h };
  };
  Scene.prototype.palette = function () {
    if (!this.colors) {
      const v = LW.cssVar;
      this.colors = {
        bg: v('--cp-surface-soft'), surface: v('--cp-surface'), border: v('--cp-border'), strong: v('--cp-border-strong'),
        text: v('--cp-text'), muted: v('--cp-text-muted'), soft: v('--cp-text-soft'), accent: v('--cp-accent'),
        accentSoft: v('--cp-accent-soft'), ok: v('--cp-success'), bad: v('--cp-danger'), warn: v('--cp-warning'), link: v('--cp-link'),
      };
    }
    return this.colors;
  };

  Scene.prototype.drawObject = function (type, x, y, broken, ghost) {
    const ctx = this.ctx, c = this.palette();
    ctx.save();
    ctx.globalAlpha = ghost ? 0.6 : 1;
    if (broken) {
      ctx.fillStyle = c.bad;
      [[-1.8, -0.6, 0.9], [1.4, -1.2, 0.7], [0.3, 1.4, 0.8], [-0.6, 0.5, 0.5], [1.9, 1.0, 0.6], [-2.2, 1.6, 0.5]].forEach(function (p) {
        ctx.beginPath();
        ctx.moveTo(x + p[0], y + p[1] - p[2]);
        ctx.lineTo(x + p[0] + p[2], y + p[1] + p[2] * 0.6);
        ctx.lineTo(x + p[0] - p[2] * 0.8, y + p[1] + p[2] * 0.4);
        ctx.closePath();
        ctx.fill();
      });
      ctx.restore();
      return;
    }
    ctx.lineWidth = 0.18;
    if (type === 'box') {
      ctx.fillStyle = c.warn; ctx.strokeStyle = c.text;
      roundRect(ctx, x - 2, y - 2, 4, 4, 0.35); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - 2, y); ctx.lineTo(x + 2, y); ctx.stroke();
    } else if (type === 'glass') {
      ctx.strokeStyle = c.link; ctx.fillStyle = c.link; ctx.lineWidth = 0.25;
      ctx.beginPath(); ctx.moveTo(x - 1.7, y - 2.3); ctx.quadraticCurveTo(x, y + 0.9, x + 1.7, y - 2.3); ctx.closePath();
      ctx.globalAlpha = (ghost ? 0.6 : 1) * 0.35; ctx.fill(); ctx.globalAlpha = ghost ? 0.6 : 1; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y - 0.4); ctx.lineTo(x, y + 1.6); ctx.moveTo(x - 1.2, y + 1.7); ctx.lineTo(x + 1.2, y + 1.7); ctx.stroke();
    } else if (type === 'towel') {
      ctx.fillStyle = c.accent; ctx.strokeStyle = c.text;
      roundRect(ctx, x - 2.6, y - 1.8, 5.2, 3.6, 0.6); ctx.fill();
      ctx.strokeStyle = c.surface; ctx.lineWidth = 0.3;
      ctx.beginPath(); ctx.moveTo(x - 2.6, y - 0.7); ctx.lineTo(x + 2.6, y - 0.7); ctx.moveTo(x - 2.6, y + 0.7); ctx.lineTo(x + 2.6, y + 0.7); ctx.stroke();
    } else if (type === 'plate') {
      ctx.strokeStyle = c.ok; ctx.fillStyle = c.ok; ctx.lineWidth = 0.25;
      circle(ctx, x, y, 2.4); ctx.globalAlpha = (ghost ? 0.6 : 1) * 0.25; ctx.fill(); ctx.globalAlpha = ghost ? 0.6 : 1; ctx.stroke();
      circle(ctx, x, y, 1.45); ctx.stroke();
    }
    ctx.restore();
  };

  Scene.prototype.drawGripper = function (x, y, held, ghost, speedRatio, fragile) {
    const ctx = this.ctx, c = this.palette();
    ctx.save();
    if (fragile && held && speedRatio != null) {
      ctx.strokeStyle = speedRatio >= 1 ? c.bad : speedRatio >= 0.8 ? c.warn : c.ok;
      ctx.lineWidth = 0.35;
      circle(ctx, x, y, 3.6); ctx.stroke();
    }
    const col = ghost ? c.soft : c.text;
    const gap = held ? 0.95 : 1.9; // half-distance between the two fingers
    ctx.globalAlpha = ghost ? 0.7 : 1;
    ctx.fillStyle = col;
    roundRect(ctx, x - gap - 0.55, y - 1.9, 0.55, 3.0, 0.22); ctx.fill();
    roundRect(ctx, x + gap, y - 1.9, 0.55, 3.0, 0.22); ctx.fill();
    ctx.fillStyle = c.surface; ctx.strokeStyle = col; ctx.lineWidth = 0.28;
    if (ghost) ctx.setLineDash([0.5, 0.4]);
    roundRect(ctx, x - gap - 0.75, y + 1.0, (gap + 0.75) * 2, 1.3, 0.45); ctx.fill(); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = col;
    circle(ctx, x, y + 2.95, 0.6); ctx.fill();
    ctx.fillStyle = c.accent;
    circle(ctx, x, y, 0.28); ctx.fill();
    ctx.restore();
  };

  /**
   * v: { type, gx, gy, ox, oy, held, trail, targetBin, graspable, speedRatio, ghost, broken, marker:{x,y,text}, hud:{left,right} }
   */
  Scene.prototype.draw = function (v) {
    this.last = v;
    const ctx = this.ctx, c = this.palette(), s = this.scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.fillStyle = c.bg; ctx.fillRect(0, 0, Sim.WORLD.w, Sim.WORLD.h);
    ctx.strokeStyle = c.border; ctx.lineWidth = 0.08;
    ctx.beginPath();
    for (let x = 10; x < Sim.WORLD.w; x += 10) { ctx.moveTo(x, 0); ctx.lineTo(x, Sim.WORLD.h); }
    for (let y = 10; y < Sim.WORLD.h; y += 10) { ctx.moveTo(0, y); ctx.lineTo(Sim.WORLD.w, y); }
    ctx.stroke();
    const fk = Math.min(1.9, Math.max(1, 720 / this.cssW)); // keep labels legible on small canvases
    ctx.setLineDash([0.8, 0.8]); ctx.strokeStyle = c.strong; ctx.lineWidth = 0.12;
    roundRect(ctx, 4, 4, 56, 52, 1.5); ctx.stroke(); ctx.setLineDash([]);
    text(ctx, 'PICK-UP AREA', 5.2, 54.2, 1.5 * fk, c.soft, 'left', 650);
    Object.keys(Sim.BINS).forEach(function (id) {
      const b = Sim.BINS[id];
      const target = v.targetBin === id;
      ctx.fillStyle = target ? c.accentSoft : c.surface;
      roundRect(ctx, b.x - b.hw, b.y - b.hh, b.hw * 2, b.hh * 2, 1.2); ctx.fill();
      ctx.lineWidth = target ? 0.32 : 0.15; ctx.strokeStyle = target ? c.accent : c.strong;
      if (target) ctx.setLineDash([1, 0.6]);
      ctx.stroke(); ctx.setLineDash([]);
      text(ctx, b.label, b.x, b.y - b.hh + 1.2 + 0.7 * fk, 1.55 * fk, target ? c.accent : c.muted, 'center', 650);
    });
    if (v.trail && v.trail.length > 1) {
      ctx.lineWidth = 0.35; ctx.lineCap = 'round';
      for (let i = 1; i < v.trail.length; i++) {
        ctx.globalAlpha = (i / v.trail.length) * 0.55;
        ctx.strokeStyle = v.ghost ? c.soft : c.accent;
        ctx.beginPath(); ctx.moveTo(v.trail[i - 1][0], v.trail[i - 1][1]); ctx.lineTo(v.trail[i][0], v.trail[i][1]); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    if (v.graspable) {
      ctx.strokeStyle = c.ok; ctx.lineWidth = 0.25; ctx.setLineDash([0.7, 0.5]);
      circle(ctx, v.ox, v.oy, Sim.GRASP_R); ctx.stroke(); ctx.setLineDash([]);
    }
    if (v.marker) {
      ctx.strokeStyle = c.accent; ctx.lineWidth = 0.3;
      circle(ctx, v.marker.x, v.marker.y, 3.6); ctx.stroke();
      text(ctx, v.marker.text, v.marker.x, v.marker.y + 5.4, 1.6 * fk, c.accent, 'center', 700);
    }
    if (v.type) this.drawObject(v.type, v.ox, v.oy, v.broken, v.ghost);
    if (v.gx != null) this.drawGripper(v.gx, v.gy, v.held, v.ghost, v.speedRatio, v.type && Sim.OBJECTS[v.type].fragile);
    if (v.hud) {
      const d = this.dpr;
      ctx.setTransform(d, 0, 0, d, 0, 0);
      const W = this.cssW, H = this.cssH, L = 16;
      ctx.strokeStyle = c.strong; ctx.lineWidth = 2;
      [[8, 8, 1, 1], [W - 8, 8, -1, 1], [8, H - 8, 1, -1], [W - 8, H - 8, -1, -1]].forEach(function (p) {
        ctx.beginPath(); ctx.moveTo(p[0], p[1] + p[3] * L); ctx.lineTo(p[0], p[1]); ctx.lineTo(p[0] + p[2] * L, p[1]); ctx.stroke();
      });
      if (v.hud.rec) { ctx.fillStyle = c.bad; circle(ctx, 22, 22, 4.5); ctx.fill(); }
      const hudPx = W < 520 ? 10.5 : 12;
      text(ctx, v.hud.left || '', v.hud.rec ? 32 : 18, 22, hudPx, c.muted, 'left', 650);
      text(ctx, v.hud.right || '', W - 18, H - 16, hudPx, c.muted, 'right', 650);
    }
  };

  LW.Scene = Scene;

  /** Draw a single frame [gx, gy, ox, oy, held] with optional trail. */
  LW.frameView = function (type, f, extra) {
    return Object.assign({ type: type, gx: f[0], gy: f[1], ox: f[2], oy: f[3], held: !!f[4] }, extra || {});
  };

  /** Animate recorded frames. Returns { stop, done } where done is a Promise. */
  LW.playFrames = function (scene, type, frames, opts) {
    opts = opts || {};
    const speed = opts.speed || 1;
    const stepMs = 1000 / Sim.HZ / speed;
    let raf = null, stopped = false, resolveDone;
    const done = new Promise(function (r) { resolveDone = r; });
    const t0 = performance.now();
    const targetBin = Sim.OBJECTS[type].bin;
    function render(i, final) {
      const f = frames[i];
      const trail = frames.slice(Math.max(0, i - 40), i + 1).map(function (x) { return [x[0], x[1]]; });
      const extra = { trail: trail, targetBin: targetBin, ghost: !!opts.ghost, hud: opts.hud ? opts.hud(i) : null };
      if (opts.handoverIndex != null && i >= opts.handoverIndex) {
        const h = frames[opts.handoverIndex];
        extra.marker = { x: h[0], y: h[1], text: 'takeover point' };
      }
      if (final && opts.outcome && opts.outcome.failure === 'broke_fragile') extra.broken = true;
      scene.draw(LW.frameView(type, f, extra));
      if (opts.onFrame) opts.onFrame(i, final);
    }
    function tick(now) {
      if (stopped) return;
      const i = Math.min(frames.length - 1, Math.floor((now - t0) / stepMs));
      const final = i >= frames.length - 1;
      render(i, final);
      if (final) { resolveDone(true); return; }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return {
      stop: function () { stopped = true; if (raf) cancelAnimationFrame(raf); resolveDone(false); },
      done: done,
    };
  };
})(window.LW);
