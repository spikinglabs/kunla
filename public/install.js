// Install Kunla as an app (KD-53). Loaded on the landing page and in the app.
// - Registers the service worker, which is what lets phones install Kunla.
// - Fills every [data-kunla-install] element (a line in the footer) with a short note and an Install button.
// - On phones, also shows a small bar at the bottom of the screen once, until it's dismissed.
// Android, Chrome and Edge get the browser's own install prompt. iPhone and iPad have no prompt,
// so Install opens the Add to Home Screen steps instead. Everything hides once Kunla runs installed.
(function () {
  if ('serviceWorker' in navigator) {
    addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
  }

  var DISMISS_KEY = 'kunla.install.dismissed';
  var ua = navigator.userAgent || '';
  // iPadOS reports itself as a Mac; touch gives it away.
  var ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  var phone = ios || /Android|Mobi/i.test(ua);
  var deferred = null;

  function installed() {
    try { if (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: window-controls-overlay)').matches) return true; } catch (e) {}
    return navigator.standalone === true;
  }
  function dismissed() { try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch (e) { return false; } }
  // prompt: the browser can install. steps: we can explain how (iPhone, iPad, other phone browsers). null: nothing to offer.
  function mode() {
    if (installed()) return null;
    if (deferred) return 'prompt';
    if (phone) return 'steps';
    return null;
  }

  var css = '' +
    '.ki-note{display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap}' +
    '.ki-btn{font:600 13px/1 var(--sans,system-ui);height:32px;padding:0 14px;border-radius:999px;border:0;background:var(--lime,#b9ff66);color:var(--on-lime,#121212);cursor:pointer;display:inline-flex;align-items:center;gap:6px}' +
    '.ki-btn svg{width:13px;height:13px}' +
    '.ki-x{width:30px;height:30px;border-radius:50%;border:0;background:none;color:inherit;opacity:.7;cursor:pointer;font-size:18px;line-height:1}' +
    '.ki-bar{position:fixed;z-index:40;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));display:flex;align-items:center;gap:10px;padding:10px 8px 10px 16px;border-radius:18px;background:var(--brain,#151513);color:var(--on-brain,#f1efe8);font:500 14px/1.35 var(--sans,system-ui);box-shadow:inset 0 0 0 1px var(--rule-2,transparent),0 18px 40px -18px rgba(0,0,0,.6)}' +
    '.ki-bar .ki-t{flex:1;min-width:0}' +
    'body.ki-bar-on{padding-bottom:84px}' +
    '.ki-bar.above-tabs{bottom:calc(76px + env(safe-area-inset-bottom,0px))}' +
    '.ki-dlg{border:1px solid var(--rule,#e0dcd1);border-radius:20px;padding:24px;max-width:min(400px,calc(100vw - 32px));background:var(--surface,#fffdf8);color:var(--ink,#121212);font:400 15px/1.5 var(--sans,system-ui)}' +
    '.ki-dlg::backdrop{background:rgba(0,0,0,.45)}' +
    '.ki-dlg h2{margin:0 0 6px;font-size:22px;letter-spacing:-.03em;font-weight:600}' +
    '.ki-dlg ol{margin:14px 0;padding-left:22px;display:grid;gap:8px}' +
    '.ki-dlg .ki-ico{display:inline-block;width:18px;height:18px;vertical-align:-3px}' +
    '.ki-dlg .ki-muted{color:var(--muted,#6c6a61);font-size:13px;margin:0 0 14px}' +
    '.ki-dlg .ki-row{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}' +
    '.ki-dlg .ki-ghost{font:500 13px/1 var(--sans,system-ui);height:32px;padding:0 14px;border-radius:999px;border:1px solid var(--rule-2,#cfcabd);background:none;color:inherit;cursor:pointer}';
  var styled = false;
  function addStyle() {
    if (styled) return; styled = true;
    var s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
  }

  var ARROW = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M3 13h10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var SHARE = '<svg class="ki-ico" viewBox="0 0 20 20" aria-label="Share"><path d="M10 2.5v10M6.5 6 10 2.5 13.5 6M6 9H4.5v8.5h11V9H14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function label() { return phone ? 'Kunla works as an app on your phone.' : 'Kunla works as an app on this computer.'; }

  function paint() {
    var m = mode();
    var spots = document.querySelectorAll('[data-kunla-install]');
    for (var i = 0; i < spots.length; i++) {
      var el = spots[i];
      if (!m) { el.hidden = true; el.innerHTML = ''; continue; }
      addStyle();
      el.hidden = false;
      el.innerHTML = '<span class="ki-note"><span>' + label() + '</span><button type="button" class="ki-btn" data-ki="go">' + ARROW + 'Install</button></span>';
    }
    var bar = document.getElementById('ki-bar');
    var wantBar = m && phone && !dismissed();
    document.body.classList.toggle('ki-bar-on', !!wantBar);
    if (!wantBar) { if (bar) bar.remove(); return; }
    addStyle();
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'ki-bar'; bar.className = 'ki-bar'; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Install Kunla');
      bar.innerHTML = '<span class="ki-t">' + label() + '</span><button type="button" class="ki-btn" data-ki="go">' + ARROW + 'Install</button><button type="button" class="ki-x" data-ki="dismiss" aria-label="Not now">×</button>';
      document.body.appendChild(bar);
    }
    // In the app the phone tab bar sits at the bottom, so the bar floats just above it.
    var tabs = document.getElementById('tabbar');
    bar.classList.toggle('above-tabs', !!tabs && tabs.getClientRects().length > 0);
  }

  function steps() {
    addStyle();
    var d = document.getElementById('ki-dlg');
    if (d) d.remove();
    d = document.createElement('dialog');
    d.id = 'ki-dlg'; d.className = 'ki-dlg'; d.setAttribute('aria-labelledby', 'ki-h');
    var token = null;
    try { token = localStorage.getItem('kunla.token'); } catch (e) {}
    var list = ios
      ? '<ol><li>Tap ' + SHARE + ' <b>Share</b> in the browser bar (at the bottom in Safari, at the top on iPad).</li><li>Scroll down and choose <b>Add to Home Screen</b>.</li><li>Tap <b>Add</b>. Kunla opens from your home screen, full screen.</li></ol>'
      : '<ol><li>Open your browser’s menu (⋮ or ≡).</li><li>Choose <b>Install app</b> or <b>Add to Home screen</b>.</li><li>Confirm. Kunla opens from your home screen, full screen.</li></ol>';
    // On iPhone and iPad the installed app keeps its own storage, so it asks for the token once.
    var note = ios && token
      ? '<p class="ki-muted">The installed app signs in separately, so it will ask for your token once. Copy it now and paste it there.</p>'
      : '';
    d.innerHTML = '<h2 id="ki-h">Install Kunla</h2><p class="ki-muted" style="margin:0">Keep Kunla on your home screen like any other app.</p>' + list + note +
      '<div class="ki-row">' + (note ? '<button type="button" class="ki-ghost" data-ki="copy">Copy my token</button>' : '') +
      '<button type="button" class="ki-btn" data-ki="close">Got it</button></div>';
    document.body.appendChild(d);
    d.addEventListener('click', function (e) {
      if (e.target === d) d.close();
      var b = e.target.closest && e.target.closest('[data-ki]');
      if (!b) return;
      if (b.dataset.ki === 'close') d.close();
      if (b.dataset.ki === 'copy' && token && navigator.clipboard) {
        navigator.clipboard.writeText(token).then(function () { b.textContent = 'Copied'; }, function () {});
      }
    });
    d.addEventListener('close', function () { d.remove(); });
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
  }

  function go() {
    if (deferred) {
      var p = deferred; deferred = null;
      p.prompt();
      p.userChoice.then(function () { paint(); }, function () { paint(); });
      return;
    }
    steps();
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-ki]');
    if (!b || b.closest('#ki-dlg')) return;
    if (b.dataset.ki === 'go') go();
    if (b.dataset.ki === 'dismiss') { try { localStorage.setItem(DISMISS_KEY, '1'); } catch (err) {} paint(); }
  });
  addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; paint(); });
  addEventListener('appinstalled', function () { deferred = null; paint(); });
  addEventListener('resize', paint);
  // The app draws its shell after sign-in; repaint so the bar can find the tab bar.
  addEventListener('hashchange', function () { setTimeout(paint, 0); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint); else paint();
  window.kunlaInstall = { paint: paint };
})();
