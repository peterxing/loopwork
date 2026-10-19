/* LoopWork: bootstrap (API mode, acting-as picker, theme toggle, router). */
(function (LW) {
  'use strict';

  async function boot() {
    try {
      await LW.api.init();
    } catch (e) {
      LW.$('#main').innerHTML = '<div class="card"><h2>Could not start LoopWork</h2><p class="muted" style="margin-top:8px">' + LW.esc(e.message) + '</p></div>';
      return;
    }
    const badge = LW.$('#modeBadge');
    if (LW.api.mode === 'server') {
      badge.className = 'pill ok';
      badge.innerHTML = '<span class="dot ok"></span> Live server';
      badge.title = 'Connected to the LoopWork server: state is authoritative and persisted on the server.';
    } else if (LW.api.hosted) {
      badge.className = 'pill accent';
      badge.textContent = 'Runs in your browser';
      badge.title = 'This public demo runs the whole LoopWork platform (engine, "server" and robot fleet) inside your browser. Nothing is sent anywhere and your progress stays on this device. Ops & pay → Reset demo starts over.';
    } else {
      badge.className = 'pill warn';
      badge.textContent = 'Offline demo';
      badge.title = 'No server detected: the same engine is running inside your browser (state saved in localStorage). Run "node server.js" for the full platform.';
    }

    await loadWorkers();
    const sel = LW.$('#actingAs');
    sel.addEventListener('change', function () {
      LW.setMe(sel.value);
      const w = LW.workerById(sel.value);
      LW.toast('Now acting as <b>' + LW.esc(w ? w.name : sel.value) + '</b>' + (w && w.simulated ? ' (simulated contributor)' : ''));
      LW.render();
    });

    LW.$('#themeToggle').addEventListener('click', function () {
      const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', cur);
      try { localStorage.setItem('loopwork-theme', cur); } catch (e) { /* ignore */ }
      if (LW.route().name === 'overview' || LW.route().name === 'lab') LW.render();
    });

    window.addEventListener('hashchange', function () {
      loadWorkers().then(LW.render);
    });
    LW.render();
  }

  async function loadWorkers() {
    try {
      const res = await LW.api.call('workers');
      LW.workers = res.workers;
      LW.cfg = res.config;
      if (!LW.workerById(LW.me())) LW.setMe('w_you');
      const sel = LW.$('#actingAs');
      sel.innerHTML = res.workers.map(function (w) {
        return '<option value="' + LW.esc(w.id) + '"' + (w.id === LW.me() ? ' selected' : '') + '>' + LW.esc(w.name) + (w.simulated ? ' · ' + LW.esc(w.persona) + ' (simulated)' : '') + '</option>';
      }).join('');
    } catch (e) {
      LW.fail(e);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.LW);
