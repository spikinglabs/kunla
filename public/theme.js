// Theme (KD-35): System, Light or Dark, remembered per device in localStorage('kunla.theme').
// Loaded as a plain blocking script in <head> of every page, so the right colors paint first (no light flash).
(function () {
  var KEY = 'kunla.theme';
  var mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  var root = document.documentElement;
  function choice() {
    try { var t = localStorage.getItem(KEY); return t === 'light' || t === 'dark' ? t : 'system'; } catch (e) { return 'system'; }
  }
  function isDark(t) { return t === 'dark' || (t === 'system' && !!mq && mq.matches); }
  function apply() {
    var t = choice();
    if (t === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
    // Phone browsers tint their address bar and status bar with this.
    var m = document.querySelector('meta[name="theme-color"]');
    if (!m) { m = document.createElement('meta'); m.name = 'theme-color'; document.head.appendChild(m); }
    m.content = isDark(t) ? '#0e0e0d' : '#f4f2ec';
    try { document.dispatchEvent(new CustomEvent('kunla:theme', { detail: { choice: t, dark: isDark(t) } })); } catch (e) {}
  }
  var ORDER = ['system', 'light', 'dark'];
  var LABEL = { system: 'System', light: 'Light', dark: 'Dark' };
  window.kunlaTheme = {
    ORDER: ORDER, LABEL: LABEL,
    get: choice,
    dark: function () { return isDark(choice()); },
    set: function (t) {
      try { if (t === 'light' || t === 'dark') localStorage.setItem(KEY, t); else localStorage.removeItem(KEY); } catch (e) {}
      apply();
    },
    next: function () { return ORDER[(ORDER.indexOf(choice()) + 1) % ORDER.length]; },
    // One icon per choice: half-filled circle (system), sun (light), moon (dark).
    icon: function (t) {
      t = t || choice();
      if (t === 'light') return '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
      if (t === 'dark') return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 10.1A5.6 5.6 0 0 1 5.9 2.8a5.6 5.6 0 1 0 7.3 7.3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
      return '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/></svg>';
    },
    // Wire a button that cycles System -> Light -> Dark and always says what it is and what comes next.
    bindButton: function (btn) {
      if (!btn) return;
      function paint() {
        var t = choice(), n = window.kunlaTheme.next();
        btn.innerHTML = window.kunlaTheme.icon(t);
        btn.title = 'Theme: ' + LABEL[t] + '. Click for ' + LABEL[n] + '.';
        btn.setAttribute('aria-label', 'Theme: ' + LABEL[t] + '. Switch to ' + LABEL[n]);
      }
      btn.addEventListener('click', function () { window.kunlaTheme.set(window.kunlaTheme.next()); });
      document.addEventListener('kunla:theme', paint);
      paint();
    },
  };
  if (mq) { if (mq.addEventListener) mq.addEventListener('change', apply); else if (mq.addListener) mq.addListener(apply); }
  // Another tab changed it: follow along.
  window.addEventListener('storage', function (e) { if (e.key === KEY) apply(); });
  apply();
})();
