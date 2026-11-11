// Kunla web app: static, no build step. Talks to the same API the agents use.
// Four places, built around what people actually do with agents:
//   Briefing  - what happened while you were away, and one decision at a time.
//   Map       - who (person or agent) worked on what, and where work is waiting on someone.
//   Task      - review and teach: fix this one, or turn the correction into a rule for every agent.
//   ⌘K        - delegate in one line (@who #PROJECT, then done-when lines) or jump anywhere.
const $ = (id) => document.getElementById(id);
const $app = $('app');
const TOKEN_KEY = 'kunla.token';
let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch {}
let me = null;
let projects = [];
let members = [];
let pollTimer = null;
let pollCheck = null;
let keyHandler = null;
let decisionCount = 0;
const deck = { i: 0 };

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const html = (strings, ...vals) => strings.reduce((out, s, i) => out + s + (i < vals.length ? (vals[i]?.__raw ?? esc(vals[i])) : ''), '');
const raw = (s) => ({ __raw: s ?? '' });
// Free text with links: long URLs become short chips so they never push a card sideways.
const linkLabel = (u) => {
  try {
    const x = new URL(u);
    const pr = x.hostname === 'github.com' && x.pathname.match(/\/(pull|issues)\/(\d+)/);
    if (pr) return `${pr[1] === 'pull' ? 'PR' : 'Issue'} #${pr[2]}`;
    if (x.hostname === 'claude.ai') return 'chat';
    return x.hostname.replace(/^www\./, '');
  } catch { return 'link'; }
};
// Mentions the server found in the text ("acme/site#12", "PR #12", "group/app!7"), each with its link
// on the project's code host (src/refs.ts, KD-42). They read as text but go to the PR, MR or issue.
const mentionLinks = (text, ms = []) => {
  const list = ms.filter((m) => m.text && !/^https?:/.test(m.text));
  if (!list.length) return esc(text);
  const re = new RegExp(list.map((m) => m.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|'), 'g');
  let out = ''; let at = 0;
  for (const m of text.matchAll(re)) {
    const hit = list.find((x) => x.text === m[0]);
    out += esc(text.slice(at, m.index)) + html`<a class="inline-link mention" href="${hit.url}" target="_blank" rel="noopener" title="${hit.url}">${m[0]} ↗</a>`;
    at = m.index + m[0].length;
  }
  return out + esc(text.slice(at));
};
const prose = (s, ms) => raw(String(s ?? '').split(/(https?:\/\/[^\s<>"']+)/g).map((part, i) => {
  if (i % 2 === 0) return mentionLinks(part, ms);
  const m = part.match(/^(.*?)([.,;:!?)\]]*)$/);
  return html`<a class="inline-link" href="${m[1]}" target="_blank" rel="noopener" title="${m[1]}">${linkLabel(m[1])} ↗</a>` + esc(m[2]);
}).join(''));
const join = (arr) => raw(arr.join(''));
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

function span(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 && h < 6 ? ' ' + (m % 60) + 'm' : ''}`;
  return `${Math.floor(h / 24)}d ${h % 24 ? (h % 24) + 'h' : ''}`.trim();
}
const ago = (iso) => (iso ? span(Date.now() - new Date(iso).getTime()) : '');
const agoLong = (iso) => { const a = ago(iso); return a === 'now' ? 'just now' : `${a} ago`; };
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayShort = (d) => {
  const t = new Date(); const y = new Date(t); y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${d.getDate()}`;
};
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const when = (iso) => { const d = new Date(iso); const day = dayShort(d); return `${day === 'Today' ? '' : (day === 'Yesterday' ? 'Yest' : d.toLocaleDateString([], { weekday: 'short' })) + ' '}${hhmm(d)}`; };
const initials = (name) => (name || '?').replace(/'s\b/g, '').split(/[\s.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const av = (m, cls = '', live = false) => m ? html`<span class="av ${m.kind === 'ai' ? 'ai' : ''} ${cls}" title="${m.name}${m.kind === 'ai' ? ' (agent)' : ''}">${initials(m.name)}${raw(live ? '<i class="dot"></i>' : '')}</span>` : '';
const who = (m, fallback = 'Nobody yet', cls = 'sm') => m ? html`<span class="who">${raw(av(m, cls))}<span class="name">${m.name}</span></span>` : html`<span class="muted">${fallback}</span>`;
const PLATFORM = { 'claude-code': 'Claude Code', 'claude-ai': 'claude.ai', codex: 'Codex', chat: 'Chat app', other: 'MCP agent' };
const kindLine = (m) => m.kind === 'ai' ? `Agent${m.platform ? ' · ' + (PLATFORM[m.platform] || m.platform) : ''}${m.sponsor ? ' · sponsored by ' + m.sponsor : ''}` : 'Person';
// Kinds of work (KD-37): not only code. The server guesses a kind when nobody set one.
// Labels by key: Kunla's defaults plus every kind the workspace and its projects define (Projects page).
const KIND = { code: 'Code', writing: 'Writing', research: 'Research', learning: 'Learning', discussion: 'Discussion', outreach: 'Outreach', design: 'Design', operations: 'Operations', other: 'Other' };
let kindsInfo = null;
async function loadKinds() {
  try { kindsInfo = await api('GET', '/api/kinds'); } catch { return; }
  for (const d of [...kindsInfo.workspace.kinds, ...kindsInfo.projects.flatMap((p) => p.kinds)]) KIND[d.key] = d.label;
}
const kindName = (k) => KIND[k] || String(k || '').replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
const kindChip = (k) => (k && k !== 'other' ? html`<span class="kind k-${k}">${kindName(k)}</span>` : '');
const LINK_TYPE = { pr: 'PR', issue: 'Issue', commit: 'Commit', repo: 'Repo', doc: 'Doc', sheet: 'Sheet', slides: 'Slides', form: 'Form', paper: 'Paper', chat: 'Chat', post: 'Post', video: 'Video', design: 'Design', file: 'File' };
const linkPill = (d) => { let host = d.url; try { host = new URL(d.url).hostname.replace(/^www\./, ''); } catch {}
  return html`<a class="pill" href="${d.url}" target="_blank" rel="noopener" title="${d.title || d.url}">${raw(LINK_TYPE[d.type] ? html`<span class="ltype">${LINK_TYPE[d.type]}</span>` : '')}<span class="pill-t">${d.title || host}</span> ↗</a>`; };
// Written outcomes: paper notes, decisions from a discussion, findings. Long ones fold.
const notesBlock = (notes, { fold = false } = {}) => (notes?.length ? notes.map((n) => {
  const long = fold && n.body.length > 600;
  const head = html`<div class="nhead"><b>${n.title || 'Notes'}</b><span class="muted">${n.author ? n.author + ' · ' : ''}${agoLong(n.created_at)}</span></div>`;
  return long ? html`<details class="notes"><summary>${raw(head)}<span class="nprev">${n.body.slice(0, 220)}…</span></summary><div class="prose">${prose(n.body)}</div></details>`
    : html`<div class="notes">${raw(head)}<div class="prose">${prose(n.body)}</div></div>`;
}).join('') : '');
const CLOCK = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.3 1.6" stroke-linecap="round"/></svg>';
const STATUS = { inbox: 'Proposed', ready: 'Ready', in_progress: 'In progress', blocked: 'Waiting on an answer', review: 'In review', done: 'Done', declined: 'Declined', parked: 'Later' };
// One sentence on what each state means, shown by the small ? hints (hover or focus on desktop, tap on phone).
const STATUS_HINT = {
  inbox: 'Suggested by an agent. A person accepts it, which moves it to Ready, or declines it.',
  ready: 'Accepted and waiting to be picked up. Nobody is working on it yet. Anyone, person or agent, can claim it, unless it names who should.',
  in_progress: 'Someone claimed it and is working on it. Only they change it until they hand it off. An agent that goes quiet for 30 minutes loses it back to Ready.',
  blocked: 'The person or agent working on it asked a question and cannot go on until someone answers it.',
  review: 'The work is handed in. A person approves it (for a pull request that means merge) or sends it back with notes.',
  done: 'Approved and finished.',
  declined: 'A person said no to this proposal.',
  parked: 'A person put it off on purpose. Agents leave it alone until someone brings it back.',
};
const PROPOSAL_HINT = 'An agent suggested this task. Accept moves it to Ready, where anyone, person or agent, can pick it up; nobody starts until then. Decline says no and keeps it in the record. Later puts the card aside.';
const hint = (text, label) => html`<button type="button" class="qhint" data-tip="${text}" aria-label="${label}">?</button>`;
const projectOf = (key) => projects.find((p) => key?.startsWith(p.key + '-'));
const firstName = (n) => n?.split(' ')[0] ?? '';
const callName = (m) => (m ? (m.kind === 'ai' ? m.name : firstName(m.name)) : '');

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (res.status === 401 && path !== '/api/setup') { signOut(); throw new Error('Your session ended. Sign in again.'); }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

function signOut() {
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
  token = null; me = null;
  location.hash = '';
  route();
}

// Wire up [data-act="event:name"] elements inside a root after each render.
function bind(root, handlers) {
  root.querySelectorAll('[data-act]').forEach((el) => {
    for (const spec of el.dataset.act.split(' ')) {
      const [ev, name] = spec.split(':');
      el.addEventListener(ev, async (e) => {
        if (ev === 'submit' || (ev === 'click' && (el.tagName === 'A' || el.tagName === 'BUTTON'))) e.preventDefault();
        try { await handlers[name](el, e); } catch (err) { toast(err.message); }
      });
    }
  });
  fillPrStates(root);
}

// Approve in Kunla = merge the PR: review cards for work that is a GitHub PR say so, with the PR's checks.
const prNumber = (deliverables) => { for (const d of deliverables || []) { const m = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/.exec(d.url || ''); if (m) return m[1]; } return null; };
function fillPrStates(root) {
  root.querySelectorAll('[data-pr]:not([data-filled])').forEach(async (el) => {
    el.dataset.filled = '1';
    try {
      const r = await api('GET', `/api/tasks/${encodeURIComponent(el.dataset.pr)}/pr`);
      if (!r.pr) return;
      const n = `PR #${r.pr.number}`;
      // The button names the PR only when approving will actually merge it.
      const btn = root.querySelector(`[data-prbtn="${CSS.escape(el.dataset.pr)}"]`);
      if (btn && r.state !== 'merged' && r.state !== 'closed' && !r.error) btn.textContent = `Approve and merge ${n}`;
      el.textContent = r.merge_by === 'agent' ? `Approving asks the agent to merge ${n} once its checks pass.`
        : r.error ? `Kunla couldn't read ${n}: ${r.error}`
        : r.state === 'merged' ? `${n} is already merged, so approving just finishes the task.`
        : r.state === 'closed' ? `${n} is closed.`
        : r.conflict ? `${n} has a conflict, so approving sends it back to fix.`
        : r.checks === 'red' ? `${n}: checks are failing, so approving sends it back to fix.`
        : r.checks === 'pending' ? `${n}: checks are running; it merges when they pass.`
        : `${n}: checks pass; approving merges it.`;
      el.className = `prstate ${r.conflict || r.checks === 'red' ? 'bad' : r.checks === 'green' ? 'ok' : ''}`;
    } catch { /* the card works without it */ }
  });
}
const formData = (form) => Object.fromEntries(new FormData(form).entries());
const typing = () => document.activeElement?.matches('input, textarea, select');

// ---------- theme ----------
// public/theme.js (loaded in <head>) applies the saved choice before paint; here we only wire the controls.
const theme = window.kunlaTheme;
theme?.bindButton($('theme'));
const themePicker = () => theme ? html`<div class="pad row theme-row" style="border-top:1px solid var(--rule)"><span class="label grow">Appearance</span>
    <div class="segctl" role="radiogroup" aria-label="Appearance">${raw(theme.ORDER.map((t) => html`<button type="button" role="radio" aria-checked="${String(theme.get() === t)}" data-theme-pick="${t}">${raw(theme.icon(t))}<span>${theme.LABEL[t]}</span></button>`).join(''))}</div></div>` : '';
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-theme-pick]'); if (!b || !theme) return;
  theme.set(b.dataset.themePick);
  for (const x of b.parentElement.children) x.setAttribute('aria-checked', String(x === b));
});

// ---------- hints ----------
// One floating tip for every [data-tip] button. Mouse: hover. Keyboard: focus. Touch: tap to open, tap again or anywhere else to close.
// It floats above the page (position: fixed) so scrolling board columns never clip it.
const tipEl = document.createElement('div');
tipEl.className = 'qtip'; tipEl.id = 'qtip'; tipEl.setAttribute('role', 'tooltip'); tipEl.hidden = true;
document.body.appendChild(tipEl);
let tipFor = null, tipAt = 0;
function showTip(el) {
  tipFor = el; tipAt = Date.now();
  tipEl.textContent = el.dataset.tip; tipEl.hidden = false;
  el.setAttribute('aria-describedby', 'qtip'); el.setAttribute('aria-expanded', 'true');
  const r = el.getBoundingClientRect(), w = tipEl.offsetWidth, h = tipEl.offsetHeight, vw = innerWidth, vh = innerHeight;
  const left = Math.max(12, Math.min(vw - w - 12, r.left + r.width / 2 - w / 2));
  const top = r.bottom + 8 + h > vh - 12 && r.top - 8 - h > 12 ? r.top - 8 - h : r.bottom + 8;
  tipEl.style.left = left + 'px'; tipEl.style.top = top + 'px';
}
function hideTip() {
  if (!tipFor) return;
  tipFor.removeAttribute('aria-describedby'); tipFor.setAttribute('aria-expanded', 'false');
  tipFor = null; tipEl.hidden = true;
}
document.addEventListener('pointerover', (e) => { const b = e.target.closest?.('[data-tip]'); if (b && e.pointerType === 'mouse' && b !== tipFor) showTip(b); });
document.addEventListener('pointerout', (e) => { const b = e.target.closest?.('[data-tip]'); if (b && e.pointerType === 'mouse' && !b.contains(e.relatedTarget) && document.activeElement !== b) hideTip(); });
document.addEventListener('focusin', (e) => { if (e.target.matches?.('[data-tip]')) showTip(e.target); });
document.addEventListener('focusout', (e) => { if (e.target === tipFor) hideTip(); });
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-tip]');
  if (!b) { hideTip(); return; }
  e.preventDefault(); e.stopPropagation();
  if (b === tipFor && Date.now() - tipAt > 400) hideTip(); else showTip(b);
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
addEventListener('scroll', hideTip, true);
addEventListener('resize', hideTip);
addEventListener('hashchange', hideTip);

// ---------- sign in and first-run setup ----------
const WORD = '<span class="wordmark">kunla<i></i></span>';
async function viewGate() {
  $('shell').hidden = true;
  const gate = $('gate');
  gate.hidden = false;
  const s = await api('GET', '/api/setup');
  // Sign in with Google or Microsoft (KD-68) when this Kunla offers it; a failed attempt comes back with ?signin_error.
  const providers = s.set_up ? ((await api('GET', '/api/edition').catch(() => null))?.sign_in || []) : [];
  const q = new URLSearchParams(location.search), signInErr = q.get('signin_error');
  if (signInErr) history.replaceState(null, '', location.pathname + location.hash);
  gate.innerHTML = !s.set_up ? html`<div class="gate-card">${raw(WORD)}
      <div class="stack" style="gap:6px"><h1>Start your team's record of work</h1>
      <p class="muted">You're the first member. Your agents join next, each under its own name, sponsored by you.</p></div>
      <form class="stack" data-act="submit:setup">
        <div class="field"><label for="g-name">Your name</label><input id="g-name" name="name" required autocomplete="name"></div>
        <div class="row" style="align-items:flex-end;flex-wrap:nowrap"><div class="field grow"><label for="g-ws">Workspace</label><input id="g-ws" name="workspace_name" required placeholder="Acme, My startup, Community…"></div>
          <div class="field" style="width:110px"><label for="g-wk">Key</label><input id="g-wk" name="workspace_key" required placeholder="ACME" maxlength="10" style="font-family:var(--mono);text-transform:uppercase"></div></div>
        <span class="muted" style="font-size:12px;margin-top:-8px">One workspace per part of your life. Its people, agents and data stay separate from your other workspaces. Tasks are numbered ACME-1, ACME-2; projects are optional and can come later.</span>
        ${raw(s.needs_setup_token ? html`<div class="field"><label for="g-st">Setup token</label><input id="g-st" name="setup_token" required type="password"></div>` : '')}
        <button class="primary">Create workspace</button>
      </form></div>`
    : html`<div class="gate-card">${raw(WORD)}
      <div class="stack" style="gap:6px"><h1>Sign in</h1>${raw(signInErr ? html`<p role="alert" style="color:var(--warn)">${signInErr}</p>` : '')}${raw(providers.length ? html`<div class="stack" style="gap:8px">${raw(providers.map((p) => html`<a class="btn go" href="${p.url}">${p.label}</a>`).join(''))}</div><p class="muted">Or paste your personal token. Whoever added you to Kunla has it.</p>` : '<p class="muted">Paste your personal token. Whoever added you to Kunla has it.</p>')}</div>
      <form class="stack" data-act="submit:signin">
        <div class="field"><label for="g-token">Token</label><input id="g-token" name="token" required placeholder="kun_…" type="password" autocomplete="current-password"></div>
        <button class="primary">Sign in</button>
      </form></div>`;
  bind(gate, {
    setup: async (f) => {
      const r = await api('POST', '/api/setup', formData(f));
      token = r.token; try { localStorage.setItem(TOKEN_KEY, token); } catch {}
      gate.innerHTML = html`<div class="gate-card">${raw(WORD)}
        <div class="stack" style="gap:6px"><h1>Save your token</h1><p class="muted">It signs you in on other devices and is shown once. Put it in your password manager now.</p></div>
        <div class="secret">${token}</div>
        <button class="primary" data-act="click:go">Next: connect your first agent</button></div>`;
      bind(gate, { go: () => { location.hash = '#/team/connect'; route(); } });
    },
    signin: async (f) => {
      token = formData(f).token.trim();
      try { localStorage.setItem(TOKEN_KEY, token); } catch {}
      route();
    },
  });
}

// ---------- shell ----------
const NAV = [['', 'Briefing'], ['map', 'Map'], ['tasks', 'Tasks'], ['team', 'Team'], ['projects', 'Projects']];
function renderShell(view) {
  const link = ([k, label]) => html`<a href="#/${k}" class="${k === view ? 'on' : ''}">${label}${raw(k === '' && decisionCount ? `<span class="n">${decisionCount}</span>` : '')}</a>`;
  $('nav').innerHTML = NAV.map(link).join('');
  $('tabbar').innerHTML = NAV.map(link).join('');
  $('me').innerHTML = av({ name: me.name, kind: 'human' });
  $('me').title = `${me.name}: workspaces, appearance and sign out`;
  $('space').innerHTML = html`<span class="sp-dot"></span><span class="sp-name">${me.workspace?.name ?? 'Workspace'}</span><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
}

// ---------- workspaces ----------
// A workspace is a hard boundary: its own people, agents and data, reached with its own token.
// Several can live in this Kunla, and others can be on other deployments. The browser keeps one
// token per workspace and asks each one directly. Signing in with Google or Microsoft fills it with every
// workspace that knows your email (KD-29).
const SPACES_KEY = 'kunla.spaces';
const loadSpaces = () => { try { return JSON.parse(localStorage.getItem(SPACES_KEY) || '[]'); } catch { return []; } };
const saveSpaces = (l) => { try { localStorage.setItem(SPACES_KEY, JSON.stringify(l)); } catch {} };
// Entries saved before there were several workspaces per address have no ws; treat them as this one.
const isHere = (x) => x.url === location.origin && (!x.ws || x.ws === me?.workspace?.id);
const sameSpace = (a, b) => a.url === b.url && (a.ws ?? null) === (b.ws ?? null);
function rememberSpace() {
  const list = loadSpaces().filter((x) => !isHere(x));
  list.unshift({ url: location.origin, ws: me.workspace?.id, token, name: me.workspace?.name ?? location.host });
  saveSpaces(list);
}
const otherSpaces = () => loadSpaces().filter((x) => !isHere(x));
const where = (sp) => (sp.url === location.origin ? 'this Kunla' : new URL(sp.url).host);
async function spaceCounts() {
  return Promise.all(otherSpaces().map(async (sp) => {
    try {
      const r = await fetch(sp.url + '/api/inbox', { headers: { authorization: `Bearer ${sp.token}` }, signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error();
      return { ...sp, count: (await r.json()).count, ok: true };
    } catch { return { ...sp, ok: false }; }
  }));
}
// The token travels in the URL fragment, which browsers never send to a server.
// Within this Kunla only the fragment changes, so the app switches without reloading.
const closePalette = () => { const box = $('palette'); box.hidden = true; box.innerHTML = ''; };
const switchTo = (sp) => { closePalette(); location.href = `${sp.url === location.origin ? location.pathname : sp.url + '/'}#/use/${encodeURIComponent(sp.token)}`; };
async function openSpaces() {
  const box = $('palette');
  box.hidden = false;
  box.innerHTML = html`<div class="pal spaces" role="dialog" aria-label="Workspaces"><div class="pad stack" style="gap:6px"><span class="eyebrow">Workspaces</span>
      <p class="muted" style="font-size:13.5px">Each one keeps its own people, agents and data. Only this browser knows you belong to all of them.</p></div>
    <div class="opts" id="sp-list"><div class="opt on"><span class="ic">${initials(me.workspace?.name)}</span><div class="grow"><div class="t">${me.workspace?.name}</div><small>${me.workspace?.key} · this one · ${plural(projects.length, 'project')} · ${plural(decisionCount, 'decision')}</small></div></div></div>
    ${raw(me.roles?.includes('admin') ? html`<form class="pad stack" data-act="submit:create" style="border-top:1px solid var(--rule)"><div class="label">New workspace</div>
      <div class="row" style="flex-wrap:nowrap"><input name="name" required maxlength="80" placeholder="Community, My startup, Work…" aria-label="Workspace name"><input name="key" maxlength="10" placeholder="Key" aria-label="Task key prefix (optional)" style="max-width:84px;font-family:var(--mono);text-transform:uppercase"></div>
      <span class="muted" style="font-size:12px">Fully separate: nothing here is visible there. You join it as its admin; the key is picked for you if you leave it empty.</span>
      <div class="row"><button class="btn go sm">Create</button></div></form>` : '')}
    <details class="pad" style="border-top:1px solid var(--rule)"><summary class="label" style="cursor:pointer">Join a workspace on another Kunla</summary>
      <form class="stack" data-act="submit:add" style="margin-top:8px">
      <div class="row" style="flex-wrap:nowrap"><input name="url" required placeholder="https://kunla.other-org.com" aria-label="Kunla address"><input name="token" required type="password" placeholder="kun_…" aria-label="Your token there" style="max-width:180px"></div>
      <div class="row"><button class="btn sm">Join</button></div></form></details>
    ${raw(themePicker())}
    <div class="pad row" style="border-top:1px solid var(--rule)"><span class="spacer grow"></span><button class="btn quiet sm" type="button" data-act="click:out">Sign out of ${me.workspace?.name}</button></div></div>`;
  box.onclick = (e) => { if (e.target === box) { box.hidden = true; box.innerHTML = ''; } };
  bind(box, {
    add: async (f) => {
      const d = formData(f); const url = d.url.trim().replace(/\/$/, '');
      const r = await fetch(url + '/api/me', { headers: { authorization: `Bearer ${d.token.trim()}` } }).catch(() => null);
      if (!r?.ok) throw new Error('That address and token did not work together.');
      const who = await r.json();
      const entry = { url, ws: who.workspace?.id, token: d.token.trim(), name: who.workspace?.name ?? new URL(url).host };
      saveSpaces([...loadSpaces().filter((x) => !sameSpace(x, entry)), entry]);
      toast(`Added ${who.workspace?.name}.`); openSpaces();
    },
    create: async (f) => {
      const d = formData(f);
      const r = await api('POST', '/api/workspaces', { name: d.name, key: d.key?.trim() || undefined });
      const entry = { url: location.origin, ws: r.workspace.id, token: r.token, name: r.workspace.name };
      saveSpaces([...loadSpaces().filter((x) => !sameSpace(x, entry)), entry]);
      // The token is the only way back in from another device, so show it once, like at setup.
      box.innerHTML = html`<div class="pal spaces" role="dialog" aria-label="New workspace"><div class="pad stack">
        <span class="eyebrow">New workspace · ${r.workspace.key}</span><h2 style="margin:0">${r.workspace.name} is ready</h2>
        <p class="muted" style="font-size:13.5px">This browser remembers it. To sign in to ${r.workspace.name} on another device, you need this token; it is shown once, so put it in your password manager.</p>
        ${raw(copyBlock('Your token for ' + r.workspace.name, r.token, { secret: true }))}
        <div class="row"><button class="btn go" data-act="click:open">Open ${r.workspace.name}</button><button class="btn quiet" data-act="click:stay">Stay here</button></div></div></div>`;
      bind(box, {
        open: () => { box.hidden = true; switchTo(entry); }, stay: () => { box.hidden = true; box.innerHTML = ''; },
        copy: async (el) => { try { await navigator.clipboard.writeText(el.dataset.v); el.textContent = 'Copied'; } catch { toast('Copy did not work here. Select the text and copy it.'); } },
      });
    },
    out: () => { saveSpaces(loadSpaces().filter((x) => !isHere(x))); box.hidden = true; signOut(); },
  });
  const rows = await spaceCounts();
  const list = $('sp-list');
  if (!list) return;
  list.insertAdjacentHTML('beforeend', rows.map((sp, i) => html`<div class="opt" data-i="${i}"><span class="ic">${initials(sp.name)}</span><div class="grow"><div class="t">${sp.name}</div>
    <small>${where(sp)} · ${sp.ok ? plural(sp.count, 'decision') : 'not reachable'}</small></div><kbd>↵</kbd></div>`).join(''));
  list.querySelectorAll('.opt[data-i]').forEach((el) => { el.onclick = () => switchTo(rows[Number(el.dataset.i)]); });
}
$('me').onclick = () => openSpaces();
$('space').onclick = () => openSpaces();
$('cmdk').onclick = () => openPalette();

// ---------- decisions (shared by the briefing deck and the task page) ----------
function decisionCard(item, { solo = false } = {}) {
  const t = item.task;
  const p = projectOf(t.key);
  const worker = t.assignee;
  const head = (label) => html`<div class="row" style="justify-content:space-between"><span class="eyebrow">${label} · ${t.key}${p ? ' · ' + p.name : ''}${raw(t.kind && t.kind !== 'other' ? ' · ' + esc(kindName(t.kind)) : '')}</span>
    ${raw(solo ? '' : html`<a class="btn quiet sm" href="#/t/${t.key}">Open</a>`)}</div>`;
  const title = solo ? '' : html`<h2><a href="#/t/${t.key}">${t.title}</a></h2>`;
  if (item.kind === 'review') {
    const round = t.review_rounds > 0 ? ` · round ${t.review_rounds + 1}` : '';
    return html`<form class="decision ${solo ? '' : 'card'}" data-key="${t.key}" data-act="submit:approve">
      ${raw(head(solo ? 'Waiting on your review' : 'Review'))}${raw(title)}
      <div class="byline">${raw(who(worker, t.deliverables?.some((d) => /^https:\/\/github\.com\//.test(d.url)) ? 'GitHub' : 'Someone'))}<span>sent this ${agoLong(t.updated_at)}${round}</span></div>
      ${raw(t.summary ? html`<p class="said">${prose(t.summary, t.mentions)}</p>` : '')}
      ${raw(t.deliverables?.length ? html`<div class="links">${join(t.deliverables.map(linkPill))}</div>` : '')}
      ${raw(notesBlock(t.notes, { fold: true }))}
      ${raw(t.criteria?.length ? html`<div><div class="label" style="margin-bottom:6px">Tick what's met</div><div class="checks">${join(t.criteria.map((c, i) => html`<label class="check"><input type="checkbox" name="c${i}" data-crit="${c}"><span>${c}</span></label>`))}</div></div>` : '')}
      <div class="field"><label for="n-${t.key}">Note to ${callName(worker) || 'the worker'}</label>
        <textarea id="n-${t.key}" name="note" rows="2" placeholder="Optional when approving. Say what to fix when sending it back."></textarea></div>
      <div class="teach" data-teach>
        <label class="check"><input type="checkbox" name="teach" data-act="change:teach"><span><b>Teach the team.</b> <span class="hint">Turn this into a rule sent with every future ${p?.key ?? ''} task, to every agent.</span></span></label>
        <div hidden data-rule><input name="rule" aria-label="Rule" placeholder="e.g. Every pricing tier shows a price."></div>
      </div>
      ${raw(prNumber(t.deliverables) ? html`<p class="prstate" data-pr="${t.key}"></p>` : '')}
      <div class="acts">
        <button class="btn go" name="v" value="approved"><span data-prbtn="${t.key}">Approve</span> <kbd>A</kbd></button>
        <button class="btn" type="button" data-act="click:changes">Send back <kbd>C</kbd></button>
        <span class="spacer"></span>
        <button class="btn quiet" type="button" data-act="click:later">Later <kbd>L</kbd></button>
      </div></form>`;
  }
  if (item.kind === 'question') {
    return html`<form class="decision ${solo ? '' : 'card'}" data-key="${t.key}" data-act="submit:answer">
      ${raw(head('Question'))}${raw(title)}
      <div class="byline">${raw(who(worker, 'An agent'))}<span>is stuck and asked ${agoLong(t.updated_at)}</span></div>
      <p class="ask">“${prose(t.blocked_question, t.mentions)}”</p>
      <div class="field"><label for="a-${t.key}">Your answer</label><textarea id="a-${t.key}" name="answer" rows="3" required placeholder="${callName(worker) || 'It'} continues as soon as you send this."></textarea></div>
      <div class="acts"><button class="btn go">Send answer <kbd>⌘↵</kbd></button><span class="spacer"></span>
        <button class="btn quiet" type="button" data-act="click:later">Later <kbd>L</kbd></button></div></form>`;
  }
  if (item.kind === 'proposal') {
    return html`<div class="decision ${solo ? '' : 'card'}" data-key="${t.key}">
      ${raw(head('Proposal'))}${raw(title)}
      <div class="byline">${raw(who(t.created_by, 'Someone'))}<span>suggested this ${agoLong(t.created_at)}</span></div>
      ${raw(t.brief ? html`<p class="said">${prose(t.brief, t.mentions)}</p>` : '')}
      ${raw(t.mentions?.length ? html`<div class="links">${join(t.mentions.map(linkPill))}</div>` : '')}
      <div class="acts"><button class="btn go" data-act="click:accept">Accept <kbd>A</kbd></button>
        <button class="btn" data-act="click:decline">Decline</button>${raw(hint(PROPOSAL_HINT, 'What Accept and Decline do'))}<span class="spacer"></span>
        <button class="btn quiet" type="button" data-act="click:later">Later <kbd>L</kbd></button></div></div>`;
  }
  if (item.kind === 'assumption') {
    const a = item.assumption;
    return html`<form class="decision ${solo ? '' : 'card'}" data-key="${t.key}" data-aid="${a.id}" data-act="submit:correct">
      ${raw(head('Assumption'))}${raw(title)}
      <div class="byline">${raw(who(a.made_by, 'An agent'))}<span>went ahead ${agoLong(a.at)} instead of waiting, assuming</span></div>
      <p class="said">“${a.text}”</p>
      <div class="field"><label for="x-${a.id}">If that's wrong, what's right?</label><textarea id="x-${a.id}" name="correct" rows="2" placeholder="${callName(a.made_by) || 'It'} gets this on ${t.key} and adjusts the work."></textarea></div>
      <div class="acts"><button class="btn go" type="button" data-act="click:confirm">Right <kbd>A</kbd></button><button class="btn">Correct it</button>
        ${raw(hint('An agent made this assumption so it could keep going instead of waiting for an answer. Right just goes in the record. Correct it sends your answer to the agent, and work in review or done goes back to it.', 'What Right and Correct do'))}<span class="spacer"></span>
        <button class="btn quiet" type="button" data-act="click:later">Later <kbd>L</kbd></button></div></form>`;
  }
  return html`<div class="decision ${solo ? '' : 'card'}" data-key="${t.key}">
    ${raw(head('Going in circles'))}${raw(title)}
    <p class="said">${t.review_rounds} review rounds and still not right. Rewrite the brief, add a check, or take it over.</p>
    <div class="acts"><a class="btn ink" href="#/t/${t.key}">Open the task</a>${raw(solo ? '' : '<span class="spacer"></span><button class="btn quiet" type="button" data-act="click:later">Later <kbd>L</kbd></button>')}</div></div>`;
}

// Actions on a decision card. after() re-renders whatever page holds it.
function decisionHandlers(after, later) {
  const keyOf = (el) => el.closest('[data-key]').dataset.key;
  const form = (el) => el.closest('form');
  const send = async (el, verdict) => {
    const f = form(el);
    const d = formData(f);
    const unmet = [...f.querySelectorAll('[data-crit]')].filter((c) => !c.checked).map((c) => c.dataset.crit);
    const note = (d.note || '').trim();
    const rule = d.teach ? (d.rule || '').trim() : '';
    const body = { verdict };
    if (verdict === 'changes_requested') {
      const wrong = note || (unmet.length ? `Not met yet: ${unmet.join('; ')}.` : '');
      if (!wrong) { f.querySelector('textarea[name=note]').focus(); throw new Error('Say what to fix, or untick what is not met.'); }
      body.what_was_wrong = wrong;
    } else if (note) body.comment = note;
    if (rule) body.rule = rule;
    const key = keyOf(el);
    await api('POST', `/api/tasks/${key}/review`, body);
    toast(verdict === 'approved' ? `${key} approved${rule ? ' and the rule is live' : ''}.` : `${key} went back with your note${rule ? ', and every agent gets the new rule' : ''}.`);
    await after();
  };
  return {
    approve: (el, e) => send(el, (e.submitter?.value) || 'approved'),
    changes: (el) => send(el, 'changes_requested'),
    teach: (el) => {
      const box = el.closest('[data-teach]');
      box.classList.toggle('on', el.checked);
      const r = box.querySelector('[data-rule]');
      r.hidden = !el.checked;
      if (el.checked) {
        const input = r.querySelector('input');
        const note = form(el).querySelector('textarea[name=note]').value.trim();
        if (!input.value && note) input.value = note;
        input.focus();
      }
    },
    answer: async (el) => { const k = keyOf(el); await api('POST', `/api/tasks/${k}/answer`, { answer: formData(el).answer }); toast(`Answer sent. ${k} is moving again.`); await after(); },
    accept: async (el) => {
      const k = keyOf(el); const r = await api('POST', `/api/tasks/${k}/triage`, { accept: true });
      // A proposed project (KD-16) becomes a real project, not Ready work.
      if (r?.project_created) { projects = await api('GET', '/api/projects'); toast(`Project ${r.project_created.name} (${r.project_created.key}) created.`); }
      else toast(`Accepted. ${k} is Ready for anyone to pick up.`);
      await after();
    },
    decline: async (el) => { const k = keyOf(el); await api('POST', `/api/tasks/${k}/triage`, { accept: false }); toast(`${k} declined.`); await after(); },
    confirm: async (el) => { const box = el.closest('[data-aid]'); await api('POST', `/api/assumptions/${box.dataset.aid}`, { confirm: true }); toast('Confirmed. It stays in the record.'); await after(); },
    correct: async (el) => {
      const box = el.closest('[data-aid]'); const text = (formData(box).correct || '').trim();
      if (!text) { box.querySelector('textarea').focus(); throw new Error('Say what is right instead, or press Right.'); }
      const r = await api('POST', `/api/assumptions/${box.dataset.aid}`, { correct: text });
      toast(r.status === 'in_progress' ? `${r.key} went back with your correction.` : `Correction sent on ${r.key}.`); await after();
    },
    later: (el) => showLater(keyOf(el), after, later),
  };
}

// "Later": skip for now (the item stays in the inbox), or park it so it leaves the briefing, the inbox
// and agents' queues until a date, or until someone brings it back.
function showLater(key, after, skip) {
  const at = (days, hour = 9) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d; };
  const monday = () => { const d = at(1); while (d.getDay() !== 1) d.setDate(d.getDate() + 1); return d; };
  const opts = [['Tomorrow morning', at(1)], ['Next week', monday()], ['In a month', at(30)]];
  openSheet(html`<div class="sheet-body stack"><div><h2>Put ${key} off</h2>
    <p class="muted">It leaves your briefing and every agent's queue, and agents leave it alone. With a date it comes back by itself; Someday stays in Tasks under Later until you bring it back.</p></div>
    <div class="later-opts">${join(opts.map(([label, d]) => html`<button class="btn" data-act="click:park" data-until="${d.toISOString()}">${label}<small>${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</small></button>`))}
      <button class="btn" data-act="click:park" data-until="">Someday<small>no date</small></button></div>
    <form class="row" data-act="submit:pick" style="align-items:flex-end"><div class="field" style="flex:1;min-width:160px"><label for="later-d">Or pick a date</label><input id="later-d" name="d" type="date" required min="${at(1).toISOString().slice(0, 10)}"></div><button class="btn">Park</button></form>
    <div class="row">${raw(skip ? '<button class="btn quiet" data-act="click:skip">Just skip it for now</button>' : '')}<button class="btn quiet" data-act="click:close">Cancel</button></div></div>`, {
    park: (el) => park(el.dataset.until || null),
    pick: (f) => { const v = formData(f).d; const d = new Date(`${v}T09:00`); return park(d.toISOString()); },
    skip: () => { closeSheet(true); skip(); },
  });
  async function park(until) {
    await api('POST', `/api/tasks/${key}/park`, until ? { until } : {});
    closeSheet(true);
    toast(until ? `${key} is parked until ${new Date(until).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}.` : `${key} is parked for someday. Find it in Tasks under Later.`);
    await after();
  }
}

// ---------- briefing ----------
function headline(n, brief, pulse, project) {
  const h = new Date().getHours();
  const hi = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const first = firstName(me.name);
  const where = project ? ` in ${project}` : '';
  if (!n) return html`${hi}, ${first}. <em>Nothing</em>${where} needs you.`;
  return html`${hi}, ${first}. <em>${plural(n, 'decision')}</em>${where} ${n === 1 ? 'needs' : 'need'} you.`;
}

function subline(brief, pulse) {
  const verbs = [['submitted', 'sent %'], ['approved', 'approved %'], ['work_logged', 'logged work on %'], ['claimed', 'picked up %']];
  const parts = brief.members.filter((m) => m.kind === 'ai').map((m) => {
    const did = verbs.filter(([k]) => m.counts[k]).map(([k, v]) => v.replace('%', plural(m.counts[k], 'task')));
    return did.length ? html`<b>${m.name}</b> ${did.slice(0, 2).join(' and ')}` : '';
  }).filter(Boolean).slice(0, 3);
  const working = pulse.filter((p) => p.kind === 'ai' && p.state === 'working').length;
  const blocked = pulse.filter((p) => p.state === 'blocked');
  const out = [];
  const when = sinceWords(brief);
  out.push(parts.length ? `${when[0].toUpperCase() + when.slice(1)}, ${parts.join('; ')}.` : `Quiet ${when}.`);
  if (brief.rules_added) out.push(`You added ${plural(brief.rules_added, 'rule')}.`);
  if (brief.tidied) out.push(`Kunla closed ${plural(brief.tidied, 'stale proposal')}.`);
  const focus = projects.filter((p) => p.focus);
  if (focus.length) out.push(html`Focus: <b>${focus.map((p) => p.name).join(', ')}</b>.`);
  if (working) out.push(`${plural(working, 'agent')} ${working === 1 ? 'is' : 'are'} working now.`);
  if (blocked.length) out.push(html`<b>${blocked[0].name}</b> is waiting on an answer.`);
  return out.join(' ');
}

// The briefing covers "since you were last here" (KD-49), so it says how far back it reaches.
function sinceWords(brief) {
  if (!brief.since || brief.window === 'first_visit') return 'since yesterday';
  const h = (Date.now() - new Date(brief.since).getTime()) / 3600000;
  if (h < 1) return 'since you were here earlier';
  if (h < 24) return `since you were here ${plural(Math.round(h), 'hour')} ago`;
  return `since you were here ${plural(Math.round(h / 24), 'day')} ago`;
}

// Asks (KD-50): what waits on someone else for too long. The deck holds what waits on you.
const ASK_LABEL = { budget_stop: 'Stopped', question_waiting: 'Unanswered', review_waiting: 'Review waiting', quiet_promise: 'Promise quiet', quiet_claim: 'Gone quiet', overlap: 'Overlap' };

// The bottleneck (KD-84): the one thing that holds up the most work. Unstick that first.
function bottleneckCard(list) {
  const b = list?.[0];
  if (!b) return '';
  const what = b.type === 'task' ? html`<a href="#/t/${b.key}"><span class="key">${b.key}</span> ${b.title}</a>` : html`“${b.title}”`;
  const state = b.type === 'task'
    ? (b.holder ? `${b.holder.name} ${b.status === 'review' ? 'is waiting for a review' : b.status === 'blocked' ? 'is waiting on an answer' : b.status === 'parked' ? 'parked it' : 'is on it'}` : b.status === 'parked' ? 'It is parked' : 'Nobody is on it')
    : (b.holder ? `${b.holder.name} owes it` : 'Nobody owns it');
  return html`<div class="card pad bneck ${b.quiet ? 'quiet' : ''}" style="margin-top:28px"><div class="eyebrow">Bottleneck</div>
    <p class="bneck-l">${raw(what)} is holding up <b>${plural(b.holds_up, 'task')}</b>.</p>
    <p class="muted">${state}${b.quiet ? ', and nothing has moved for 2 days' : ''}. ${b.type === 'task' ? 'Moving this one moves the rest.' : b.link && /\/(pull|merge_requests)\//.test(b.link) ? 'It clears by itself when the PR merges.' : `Tick it on ${b.on} once it is true.`}</p>
    <div class="row" style="margin-top:12px">${raw(b.type === 'task' ? html`<a class="btn sm" href="#/t/${b.key}">Open ${b.key}</a>` : b.link ? html`<a class="btn sm" href="${b.link}" target="_blank" rel="noopener">Open the link ↗</a>` : html`<a class="btn sm" href="#/t/${b.on}">Open ${b.on}</a>`)}<a class="btn sm quiet" href="#/map/relations${b.key ? '/' + b.key : ''}">See how it connects</a></div></div>`;
}
function asksCard(list) {
  if (!list?.length) return '';
  const act = (a) => a.action === 'limits' ? html`<a class="btn sm" href="#/team">Change limits</a>`
    : a.action === 'take_over' ? html`<a class="btn sm" href="#/t/${a.task.key}">Take over…</a>`
    : a.action === 'compare' || (a.kind === 'quiet_promise' && a.other) ? html`<a class="btn sm quiet" href="#/t/${a.task.key}">${a.task.key}</a><a class="btn sm quiet" href="#/t/${a.other.key}">${a.other.key}</a>`
    : html`<a class="btn sm quiet" href="#/t/${a.task.key}">Open</a>`;
  return html`<div class="card pad asks" style="margin-top:28px"><div class="section-t"><h2>Needs a look</h2><span class="muted" style="font-size:13px">Waiting on someone for too long</span></div>
    <div class="ask-list">${join(list.map((a) => html`<div class="ask ${a.kind}"><span class="ask-k">${ASK_LABEL[a.kind] || a.kind}</span>
      <div class="grow"><div class="ask-l">${a.line}</div>${raw(a.task && a.action !== 'compare' ? html`<div class="muted ask-t">${a.task.title}</div>` : '')}</div>
      <div class="ask-a">${raw(act(a))}</div></div>`))}</div></div>`;
}

// The briefing deck is one horizontal scroll-snap track holding every card (KD-46). The browser moves
// the cards under the finger on its compositor thread, so a swipe is as quick as any native carousel,
// and changing card never refetches or re-renders the page: only the counter, dots and height update.
function deckTrack(track, { onChange }) {
  const cards = [...track.children];
  let i = -1, want = null; // want: the card a dot, key or button is scrolling to, so j j moves two cards
  const at = () => (track.scrollLeft >= track.scrollWidth - track.clientWidth - 1 ? cards.length - 1
    : Math.max(0, Math.min(cards.length - 1, Math.round(track.scrollLeft / Math.max(1, cards[0].offsetWidth + gap())))));
  const gap = () => parseFloat(getComputedStyle(track).columnGap) || 0;
  // The track is as tall as the card in view; between two cards it blends their heights,
  // so a short card never leaves a gap under it and a tall one never gets cut off.
  const fit = () => {
    const step = cards[0].offsetWidth + gap();
    const end = track.scrollLeft >= track.scrollWidth - track.clientWidth - 1;
    const f = end ? cards.length - 1 : track.scrollLeft / Math.max(1, step);
    const a = cards[Math.max(0, Math.min(cards.length - 1, Math.floor(f)))], b = cards[Math.max(0, Math.min(cards.length - 1, Math.ceil(f)))];
    const t = f - Math.floor(f);
    track.style.height = `${Math.ceil(a.offsetHeight + (b.offsetHeight - a.offsetHeight) * t)}px`;
  };
  let raf = 0;
  const tick = () => {
    raf = 0; fit();
    const n = at();
    if (n === want) want = null;
    if (n !== i) { i = n; cards.forEach((c, k) => { c.inert = k !== n; }); onChange(n); }
  };
  track.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(tick); }, { passive: true });
  if (window.ResizeObserver) { const ro = new ResizeObserver(() => { if (!raf) raf = requestAnimationFrame(tick); }); cards.forEach((c) => ro.observe(c)); }
  return {
    go: (n, smooth = true) => {
      n = (n + cards.length) % cards.length;
      want = n;
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      track.scrollTo({ left: n * (cards[0].offsetWidth + gap()), behavior: smooth && !reduce ? 'smooth' : 'instant' });
      if (!smooth || reduce) tick();
    },
    target: () => want ?? (i < 0 ? 0 : i),
    card: () => cards[i < 0 ? 0 : i],
    start: (n) => { track.scrollLeft = n * (cards[0].offsetWidth + gap()); tick(); },
  };
}

// Briefing narrowed to one project (KD-81). Task keys start with their project's key (KD-60), so the
// deck, the asks and the finished list all filter by key without asking the server again.
// Remembered per workspace; tasks with no project carry the workspace key.
const BRIEF_PROJECT_KEY = 'kunla.briefProject';
const briefProject = {
  get: () => { try { return JSON.parse(localStorage.getItem(BRIEF_PROJECT_KEY) || '{}')[me.workspace.key] || ''; } catch { return ''; } },
  set: (k) => { try { const all = JSON.parse(localStorage.getItem(BRIEF_PROJECT_KEY) || '{}'); if (k) all[me.workspace.key] = k; else delete all[me.workspace.key]; localStorage.setItem(BRIEF_PROJECT_KEY, JSON.stringify(all)); } catch {} },
};
const keyIn = (key, project) => !!key && key.slice(0, key.lastIndexOf('-')) === project;

async function viewBriefing() {
  renderShell('');
  const [inbox, brief, pulse, rules, prog, ready, team] = await Promise.all([
    api('GET', '/api/inbox'), api('GET', '/api/briefing'), api('GET', '/api/pulse'), api('GET', '/api/rules'), api('GET', '/api/progress'),
    api('GET', '/api/tasks?status=ready&limit=200'), me.kind === 'human' ? api('GET', '/api/members') : Promise.resolve(members),
  ]);
  members = team;
  const readyFree = ready.filter((t) => !t.assignee).length;
  // Projects first in focus order, then tasks with no project if there are any.
  const stats = [...prog.filter((x) => !x.workspace), ...prog.filter((x) => x.workspace && Object.keys(x.counts).length).map((x) => ({ ...x, name: 'No project' }))]
    .map((x) => ({ project: { key: x.key, name: x.name }, counts: x.counts }));
  decisionCount = inbox.count; renderShell('');
  // The project pills: every project with something waiting on you, in focus order; "No project" last.
  const projOf = (key) => key.slice(0, key.lastIndexOf('-'));
  const pkeys = [...new Set([...projects.map((p) => p.key), me.workspace.key])];
  const nameOf = (k) => k === me.workspace.key ? 'No project' : (projects.find((p) => p.key === k)?.name ?? k);
  const waiting = new Map();
  for (const it of inbox.items) { const k = projOf(it.task.key); waiting.set(k, (waiting.get(k) || 0) + 1); }
  let only = briefProject.get();
  if (only && !pkeys.includes(only)) { only = ''; briefProject.set(''); }
  const choices = pkeys.filter((k) => waiting.get(k) || k === only);
  const items = only ? inbox.items.filter((it) => keyIn(it.task.key, only)) : inbox.items;
  const askList = only ? (brief.asks || []).filter((a) => !a.task || keyIn(a.task.key, only) || keyIn(a.other?.key, only)) : brief.asks;
  const finished = only ? brief.finished.filter((f) => keyIn(f.key, only)) : brief.finished;
  if (deck.i >= items.length) deck.i = 0;
  const pills = choices.length > 1 || only ? html`<div class="brief-filter" role="radiogroup" aria-label="Show decisions from">
      <button class="pill ${only ? '' : 'on'}" role="radio" aria-checked="${String(!only)}" data-act="click:only" data-k="">All <span class="mono" style="opacity:.6">${inbox.items.length}</span></button>
      ${join(choices.map((k) => html`<button class="pill ${only === k ? 'on' : ''}" role="radio" aria-checked="${String(only === k)}" data-act="click:only" data-k="${k}">${nameOf(k)} <span class="mono" style="opacity:.6">${waiting.get(k) || 0}</span></button>`))}</div>` : '';
  const active = rules.filter((r) => r.active);
  const reach = active.reduce((s, r) => s + (r.sent_with || 0), 0);
  const order = { working: 0, blocked: 1, waiting: 2, idle: 3 };
  const people = [...pulse].sort((a, b) => order[a.state] - order[b.state]);

  $app.innerHTML = html`<section class="hello">
      <div class="eyebrow">${new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</div>
      <h1 style="margin-top:12px">${raw(headline(items.length, brief, pulse, only && nameOf(only)))}</h1>
      <p class="sub">${raw(subline(brief, pulse))}</p>
      <div class="row" id="elsewhere" style="margin-top:16px"></div>
    </section>
    <div class="brief">
      <section>
        ${raw(pills)}
        ${raw(items.length ? html`<div class="deck-top"><span class="eyebrow">${deck.i + 1} of ${items.length}</span>
          <div class="dots">${join(items.map((it, i) => html`<button class="${i === deck.i ? 'on' : ''}" data-act="click:go" data-i="${i}" aria-label="Decision ${i + 1}: ${it.task.key}"></button>`))}</div></div>
          <div class="deck" tabindex="-1" aria-roledescription="carousel">${join(items.map((it, i) => html`<div class="slide" aria-roledescription="slide" aria-label="${i + 1} of ${items.length}">${raw(decisionCard(it))}</div>`))}</div>`
        : html`<div class="card clear"><div class="big"><svg width="26" height="26" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
          <h2>All clear</h2><p class="muted">${only ? `Nothing in ${nameOf(only)} waits on you.` : 'Nothing waits on you. Agents keep the record up to date on their own.'}</p>
          <button class="btn ink" data-act="click:palette">Delegate something <kbd>⌘K</kbd></button></div>`)}
        ${raw(continuousNudge(readyFree))}
        ${raw(bottleneckCard(only ? (brief.bottlenecks || []).filter((b) => keyIn(b.key, only) || b.held.some((k) => keyIn(k, only))) : brief.bottlenecks))}
        ${raw(asksCard(askList))}
        ${raw(finished.length ? html`<div class="card pad" style="margin-top:28px"><div class="section-t"><h2>Finished ${sinceWords(brief)}</h2><a class="muted" href="#/map" style="font-size:13px">See the map</a></div>
          <div class="done-list">${join(finished.map((f) => html`<a href="#/t/${f.key}"><span class="key">${f.key}</span><span class="t grow">${f.title}</span><span class="muted" style="font-size:13px">${f.worker ?? ''}</span></a>`))}</div></div>` : '')}
      </section>
      <aside class="side">
        <div class="card pad"><div class="section-t"><h2>Right now</h2><a class="muted" href="#/map" style="font-size:13px">Map</a></div>
          <div class="pulse">${join(people.map((p) => html`<a class="p" href="${p.task ? '#/t/' + p.task.key : '#/team'}">${raw(av(p, '', p.live))}
            <div class="grow"><div class="nm">${p.name}</div><div class="t">${p.state === 'idle' ? (p.since ? `Last active ${agoLong(p.since)}` : 'Not active yet') : p.line}</div></div>
            <span class="state ${p.state}">${p.state === 'waiting' && !p.task ? 'you' : p.state}</span></a>`))}</div></div>
        <div class="brain"><div class="eyebrow">Team brain</div>
          <h2>${plural(active.length, 'rule')} every agent follows</h2>
          <p class="s">${active.length ? `Learned from your reviews. Sent with ${plural(reach, 'task')} since.` : 'When you send work back, tick “Teach the team” and the fix becomes a rule for every agent.'}</p>
          ${raw(active.length ? html`<ul>${join(active.slice(0, 4).map((r) => html`<li><div class="r">${r.text}</div><div class="m"><span>${r.project}${r.source_task ? ' · from ' + r.source_task : ''}</span><b>sent with ${plural(r.sent_with, 'task')}</b></div></li>`))}</ul>
            <a href="#/playbook" style="display:inline-block;margin-top:12px;font-size:13px">All rules and playbooks</a>` : '')}</div>
        <div class="card pad"><div class="section-t"><h2>Projects</h2><a class="muted" href="#/tasks" style="font-size:13px">Tasks</a></div>
          <div class="prog">${join(stats.map((s) => progress(s)))}</div></div>
      </aside>
    </div>`;
  // Swipe left or right on the card for the next or previous decision: native scrolling does it.
  const deckEl = $app.querySelector('.deck');
  const eye = $app.querySelector('.deck-top .eyebrow');
  const dots = [...$app.querySelectorAll('.deck-top .dots button')];
  const track = deckEl ? deckTrack(deckEl, { onChange: (n) => {
    deck.i = n;
    if (eye) eye.textContent = `${n + 1} of ${items.length}`;
    dots.forEach((d, k) => d.classList.toggle('on', k === n));
  } }) : null;
  track?.start(deck.i);
  bind($app, {
    ...decisionHandlers(viewBriefing, () => track?.go(track.target() + 1)),
    go: (el) => track?.go(Number(el.dataset.i)),
    only: (el) => { briefProject.set(el.dataset.k); deck.i = 0; viewBriefing(); },
    palette: () => openPalette(),
    ...nudgeHandlers(readyFree, viewBriefing),
  });
  keyHandler = (e) => {
    if (typing() || e.metaKey || e.ctrlKey || e.altKey || !$('palette').hidden || !$('sheet').hidden || !track) return;
    const k = e.key.toLowerCase();
    const card = track.card().querySelector('.decision');
    const cur = items[deck.i];
    if (k === 'a') { e.preventDefault(); card.querySelector('.btn.go')?.click(); }
    else if (k === 'c' || k === 'r') { e.preventDefault(); card.querySelector('[data-act="click:changes"]')?.click(); }
    else if (k === 'l') { e.preventDefault(); card.querySelector('[data-act="click:later"]')?.click(); }
    else if (k === 'j') { e.preventDefault(); track.go(track.target() + 1); }
    else if (k === 'k') { e.preventDefault(); track.go(track.target() - 1); }
    else if (k === 'enter' && cur) location.hash = `#/t/${cur.task.key}`;
  };
  // ⌘↵ sends an answer from the textarea.
  $app.querySelectorAll('textarea[name=answer]').forEach((ta) => ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ta.form.requestSubmit(); }));
  // What waits on you in your other workspaces, asked directly from each one.
  if (otherSpaces().length) spaceCounts().then((rows) => {
    const el = $('elsewhere');
    if (!el) return;
    el.innerHTML = '<span class="muted" style="font-size:13.5px">Elsewhere:</span>' + rows.map((sp, i) => html`<button class="pill ${sp.ok && sp.count ? 'lime' : ''}" data-i="${i}">${sp.name} · ${sp.ok ? plural(sp.count, 'decision') : 'offline'}</button>`).join('');
    el.querySelectorAll('button').forEach((b) => { b.onclick = () => switchTo(rows[Number(b.dataset.i)]); });
  });
}

const endsIn = (iso) => { if (!iso) return ''; const d = Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000); return d < 0 ? 'ended' : d === 0 ? 'ends today' : `ends in ${plural(d, 'day')}`; };
function progress(s) {
  const c = s.counts;
  const total = Object.entries(c).filter(([k]) => k !== 'declined' && k !== 'inbox').reduce((a, [, n]) => a + n, 0) || 1;
  const order = ['done', 'review', 'in_progress', 'blocked', 'ready'];
  const words = { done: 'done', review: 'in review', in_progress: 'in progress', blocked: 'waiting', ready: 'ready' };
  const p = projects.find((x) => x.key === s.project.key);
  return html`<a href="#/tasks/${s.project.key}"><div class="row" style="justify-content:space-between"><span>${raw(p?.focus ? '<span class="focus-dot" title="Focus"></span>' : '')}<b style="font-weight:600">${s.project.name}</b> <span class="key">${s.project.key === me.workspace.key ? 'workspace' : s.project.key}</span></span>
    <span class="muted" style="font-size:12.5px">${p?.ends_at ? endsIn(p.ends_at) : p ? 'ongoing' : ''}</span></div>
    <div class="bar">${join(order.filter((k) => c[k]).map((k) => html`<span class="b-${k}" style="width:${(c[k] / total) * 100}%" title="${c[k]} ${words[k]}"></span>`))}</div>
    <div class="legend">${order.filter((k) => c[k]).map((k) => `${c[k]} ${words[k]}`).join(' · ') || 'No tasks yet'}</div></a>`;
}

// ---------- work map ----------
// Range is how far back the map looks; zoom is how wide the time axis is drawn (pinch, or − / +).
const MAP_RANGES = [['6h', 0.25], ['12h', 0.5], ['1 day', 1], ['3 days', 3], ['7 days', 7], ['14 days', 14]];
const MAP_ZOOMS = [1, 1.5, 2, 3, 4, 6, 8];
let mapDays = null; // null until the first visit picks a range that fits recent activity
let mapZoom = 1;
let mapData = null;
// What each lane is: a person or agent (default), a project, or a kind of work. Remembered on this device.
const MAP_GROUPS = [['who', 'Person or agent'], ['project', 'Project'], ['work', 'Kind of work']];
let mapGroup = 'who';
try { const g = localStorage.getItem('kunla.mapGroup'); if (MAP_GROUPS.some(([k]) => k === g)) mapGroup = g; } catch {}
const MAP_SUB = {
  who: 'Who worked on what, person or agent.',
  project: 'What moved in each project, and who moved it.',
  work: 'What kinds of work got done, and who did them.',
};

// The smallest range that still shows the latest handful of work, so the first view isn't a few slivers next to "now".
async function fitMapRange() {
  const m = await api('GET', '/api/map?days=14');
  const end = new Date(m.end).getTime();
  const starts = m.lanes.flatMap((l) => l.segments.map((s) => new Date(s.start).getTime())).sort((x, y) => y - x);
  if (!starts.length) return 1;
  const need = ((end - starts[Math.min(starts.length, 8) - 1]) / 86400_000) * 1.15;
  return (MAP_RANGES.find(([, d]) => d >= need) || MAP_RANGES[MAP_RANGES.length - 1])[1];
}

async function viewMap() {
  renderShell('map');
  if (mapDays == null) mapDays = await fitMapRange();
  mapData = await api('GET', `/api/map?days=${mapDays}`);
  const m = mapData;
  const E = new Date(m.end).getTime();
  const longest = Math.max(1, ...m.waits.map((w) => E - new Date(w.since).getTime()));
  $app.innerHTML = html`${raw(mapSwitch('timeline'))}<div class="head"><div><h1>Work map</h1>
      <p class="sub">${MAP_SUB[mapGroup]} Solid is work, dashed is work waiting on someone, lime is a decision. Nobody filled this in; it comes from the record.</p></div></div>
    <div class="map-group row" role="group" aria-label="Group lanes by"><span class="label">Lanes by</span>${join(MAP_GROUPS.map(([k, label]) => html`<button class="pill ${k === mapGroup ? 'on' : ''}" data-act="click:group" data-g="${k}" aria-pressed="${k === mapGroup}">${label}</button>`))}</div>
    <div class="map-tools"><div class="row map-ranges">${join(MAP_RANGES.map(([label, d]) => html`<button class="pill ${d === mapDays ? 'on' : ''}" data-act="click:days" data-n="${d}">${label}</button>`))}</div>
      <div class="zoom" role="group" aria-label="Zoom"><button class="btn sm" data-act="click:zoomOut" aria-label="Zoom out">−</button><span id="zoomv">${mapZoom}×</span><button class="btn sm" data-act="click:zoomIn" aria-label="Zoom in">+</button></div></div>
    <div class="card"><div class="map" id="map"></div></div>
    <div class="row map-key" style="margin:14px 4px 0"><span><i style="background:var(--ink)"></i>Working</span><span><i style="border:1.5px dashed var(--wait)"></i>Waiting on someone</span>
      <span><i style="background:var(--lime)"></i>A decision</span><span><i style="background:var(--sunk)"></i>Night</span><span class="muted">Pinch or use − / + to zoom. Tap a bar to open the task.</span></div>
    <div class="card pad" style="margin-top:28px"><div class="section-t"><h2>Where work waits now</h2><span class="muted" style="font-size:13px">Oldest first: questions, reviews, and tasks waiting on other work.</span></div>
      ${raw(m.waits.length ? html`<div class="waits">${join(m.waits.map((w) => { const ms = E - new Date(w.since).getTime(); return html`<a href="#/t/${w.key}"><span class="key">${w.key}</span>
        <span class="t">${w.title}<small>${w.who}: ${w.label.replace(w.key + ' ', '')}</small></span><span class="len"><i style="width:${(ms / longest) * 100}%"></i></span><span class="for">${span(ms)}</span></a>`; }))}</div>`
      : '<p class="muted">Nothing is waiting. Every task is either moving or done.</p>')}</div>`;
  const setZoom = (z) => { const keep = mapAnchor(); mapZoom = z; drawMap(keep); };
  bind($app, {
    days: (el) => { mapDays = Number(el.dataset.n); viewMap(); },
    group: (el) => { mapGroup = el.dataset.g; try { localStorage.setItem('kunla.mapGroup', mapGroup); } catch {} viewMap(); },
    zoomIn: () => setZoom(MAP_ZOOMS.find((z) => z > mapZoom) ?? mapZoom),
    zoomOut: () => setZoom([...MAP_ZOOMS].reverse().find((z) => z < mapZoom) ?? mapZoom),
  });
  drawMap();
  pinchZoom($('map'));
}

// The same bars, regrouped into lanes by person or agent, project, or kind of work.
function mapLanes(m) {
  if (mapGroup === 'who') return m.lanes.filter((l) => l.segments.length || members.find((mm) => mm.id === l.id)?.active);
  const all = m.lanes.flatMap((l) => l.segments.map((s) => ({ ...s, who: l.name })));
  const badge = (text, cls) => html`<span class="av lane-badge ${cls}">${text}</span>`;
  const lane = (id, name, sub, b) => ({ id, name, sub, badge: b, segments: all.filter((s) => (s[mapGroup] || '') === id) });
  const out = mapGroup === 'project'
    ? [...(m.projects || []).map((p) => lane(p.key, p.name, p.workspace ? 'Not in a project' : p.key, badge(p.key.slice(0, 3), 'proj'))), lane('', 'Unknown project', '', badge('?', 'proj'))]
    : [...new Set([...Object.keys(KIND), ...all.map((s) => s.work || '')])].map((k) => lane(k, k ? kindName(k) : 'Unsorted', 'Kind of work', badge(initials(k ? kindName(k) : '?'), `kindb k-${k}`)));
  return out.filter((l) => l.segments.length);
}

const mapLabelW = () => (innerWidth < 700 ? 112 : 200);
const mapTrackW = (zoom) => Math.max(($app.clientWidth || innerWidth) - mapLabelW() - 48, 260) * zoom;

// Where the view is, as a fraction of the time axis, so zooming keeps the same moment in front of you.
function mapAnchor() {
  const sc = $('map');
  if (!sc || !sc.scrollWidth) return null;
  const lw = mapLabelW();
  const track = sc.scrollWidth - lw;
  return (sc.scrollLeft + (sc.clientWidth - lw) / 2) / track;
}
function restoreAnchor(f) {
  const sc = $('map');
  const lw = mapLabelW();
  if (f == null) { sc.scrollLeft = sc.scrollWidth; return; } // first draw: show "now"
  sc.scrollLeft = f * (sc.scrollWidth - lw) - (sc.clientWidth - lw) / 2;
}

function drawMap(anchor = null) {
  const m = mapData; const box = $('map');
  if (!m || !box) return;
  const S = new Date(m.start).getTime();
  const E = new Date(m.end).getTime();
  const pad = (E - S) * 0.03;
  const R = E + pad - S;
  const x = (t) => ((typeof t === 'number' ? t : new Date(t).getTime()) - S) / R * 100;
  const lw = mapLabelW(); const tw = mapTrackW(mapZoom);
  // Ticks: the finest step that leaves room for a label, from 1 hour to 1 day.
  const pxPerHour = tw / (R / 3600_000);
  const step = [1, 2, 3, 6, 12, 24].find((h) => h * pxPerHour >= 58) ?? 24;
  const ticks = [];
  const t0 = new Date(S); t0.setMinutes(0, 0, 0); t0.setHours(Math.ceil(t0.getHours() / step) * step);
  for (let t = new Date(t0); t.getTime() < E + pad; t.setHours(t.getHours() + step)) ticks.push(new Date(t));
  const tickLabel = (d) => (d.getHours() === 0 ? dayShort(d) : hhmm(d));
  const days = [];
  const d0 = new Date(S); d0.setHours(0, 0, 0, 0);
  for (let d = new Date(d0); d.getTime() < E + pad; d.setDate(d.getDate() + 1)) days.push(new Date(d));
  const nights = days.map((d) => {
    const a = new Date(d); a.setHours(20, 0, 0, 0);
    const b = new Date(d); b.setDate(b.getDate() + 1); b.setHours(7, 0, 0, 0);
    const l = Math.max(0, x(a.getTime())); const r = Math.min(100, x(b.getTime()));
    return r > l ? `<i class="night" style="left:${l}%;width:${r - l}%"></i>` : '';
  }).join('') + (() => { const b = new Date(d0); b.setHours(7, 0, 0, 0); const r = x(b.getTime()); return r > 0 ? `<i class="night" style="left:0;width:${Math.min(100, r)}%"></i>` : ''; })();
  const grid = ticks.map((d) => `<i class="grid-line ${d.getHours() === 0 ? 'day' : ''}" style="left:${x(d.getTime())}%"></i>`).join('');
  const nowX = x(E);
  const lanes = mapLanes(m);
  const byWho = mapGroup === 'who';
  // Bars that overlap in time go on separate rows of their lane, so none hides another. Decisions are short marks and stay on the first row.
  const stack = (segs) => {
    const ends = [];
    return segs.slice().sort((a, b) => a.start.localeCompare(b.start)).map((s) => {
      if (s.kind === 'decide') return { s, row: 0 };
      const a = x(s.start); const b = x(s.end ?? m.end);
      let row = ends.findIndex((e) => e <= a);
      if (row < 0) { row = ends.length; ends.push(b); } else ends[row] = b;
      return { s, row };
    });
  };
  const seg = ({ s, row }) => {
    const l = Math.max(0, x(s.start));
    const r = Math.min(nowX, x(s.end ?? m.end));
    const w = Math.max(0, r - l);
    const body = s.kind === 'decide' ? '' : s.kind === 'wait' ? s.label.replace(`${s.key} `, '') : s.title;
    const text = !byWho && s.kind !== 'decide' ? `${s.who}: ${body}` : body;
    const label = byWho ? s.label : `${s.who}: ${s.label}`;
    return html`<a class="seg ${s.kind} ${s.live ? 'live' : ''}" href="#/t/${s.key}" style="left:${l}%;width:${w}%;--row:${row}" title="${label} · ${when(s.start)}–${s.end ? clock(s.end) : 'now'}" aria-label="${label}"><span>${text}</span></a>`;
  };
  box.innerHTML = html`<div class="map-in" style="--label:${lw}px;width:${lw + tw}px">
    <div class="map-days"><div class="who"></div><div class="track">${join(ticks.map((d) => { const l = x(d.getTime()); return l >= 0 && l < 97 ? html`<span class="d ${d.getHours() === 0 ? 'day' : ''}" style="left:${l}%">${tickLabel(d)}</span>` : ''; }))}<i class="now" style="left:${nowX}%"></i></div></div>
    ${raw(lanes.length ? '' : '<p class="muted" style="padding:16px 0">No work recorded in this range. Try a longer one.</p>')}
    ${join(lanes.map((l) => { const segs = stack(l.segments); const rows = Math.max(1, ...segs.map((g) => g.row + 1));
      return html`<div class="lane" style="--rows:${rows}"><div class="who">${raw(l.badge ?? av(l, '', l.segments.some((s) => s.live)))}<span class="grow"><span class="name">${l.name}</span>
      <small>${l.sub ?? (l.kind === 'ai' ? PLATFORM[l.platform] || 'Agent' : 'Person')}</small></span></div>
      <div class="track">${raw(nights)}${raw(grid)}${join(segs.map(seg))}<i class="now bare" style="left:${nowX}%"></i></div></div>`; }))}
  </div>`;
  const zv = $('zoomv'); if (zv) zv.textContent = `${Math.round(mapZoom * 10) / 10}×`;
  restoreAnchor(anchor);
}

// Two-finger pinch on the map stretches the time axis live, then redraws the ticks when you let go.
function pinchZoom(el) {
  if (!el) return;
  let d0 = 0, z0 = 1, f = null;
  const dist = (e) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  el.addEventListener('touchstart', (e) => { if (e.touches.length === 2) { d0 = dist(e); z0 = mapZoom; f = mapAnchor(); } }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || !d0) return;
    e.preventDefault();
    mapZoom = Math.min(8, Math.max(1, z0 * dist(e) / d0));
    const inner = el.querySelector('.map-in');
    if (inner) inner.style.width = `${mapLabelW() + mapTrackW(mapZoom)}px`;
    restoreAnchor(f);
  }, { passive: false });
  el.addEventListener('touchend', (e) => { if (d0 && e.touches.length < 2) { d0 = 0; drawMap(f); } });
}

// ---------- relations (KD-84): how open work connects ----------
// What must happen first sits on the left, what waits on it to the right. Solid arrows are waits, dotted
// ones are sub-tasks (a parent finishes after its sub-tasks). The bottleneck holds up the most work.
const mapSwitch = (on) => html`<div class="map-switch row" role="tablist" aria-label="Map views">
  <a class="pill ${on === 'timeline' ? 'on' : ''}" role="tab" aria-selected="${String(on === 'timeline')}" href="#/map">Timeline</a>
  <a class="pill ${on === 'relations' ? 'on' : ''}" role="tab" aria-selected="${String(on === 'relations')}" href="#/map/relations">Relations</a></div>`;
let relSubs = false;
try { relSubs = localStorage.getItem('kunla.relSubs') === '1'; } catch {}

async function viewRelations(focus) {
  renderShell('map');
  const only = focus ? '' : briefProject.get();
  const q = new URLSearchParams();
  if (focus) q.set('focus', focus); else if (only) q.set('project', only);
  if (relSubs) q.set('subtasks', '1');
  const g = await api('GET', `/api/relations?${q}`);
  const pkeys = [...projects.filter((p) => p.key !== me.workspace.key).map((p) => p.key)];
  const nameOf = (k) => projects.find((p) => p.key === k)?.name ?? k;
  const b = g.bottlenecks[0];
  $app.innerHTML = html`${raw(mapSwitch('relations'))}<div class="head"><div><h1>How work connects</h1>
      <p class="sub">What has to happen first is on the left; what waits on it is to the right. Agents and people add these as they go, and they clear themselves when the work is done.</p></div></div>
    <div class="row rel-tools">${raw(focus ? html`<span class="pill on">Around ${focus}</span><a class="pill" href="#/map/relations">Everything</a>`
      : html`<button class="pill ${only ? '' : 'on'}" data-act="click:only" data-k="">All projects</button>${join(pkeys.map((k) => html`<button class="pill ${only === k ? 'on' : ''}" data-act="click:only" data-k="${k}">${nameOf(k)}</button>`))}`)}
      <span class="spacer"></span><label class="row rel-subs"><input type="checkbox" data-act="change:subs" ${relSubs ? 'checked' : ''}> All sub-tasks</label></div>
    ${raw(b ? html`<div class="card pad bneck ${b.quiet ? 'quiet' : ''}" style="margin:14px 0 0"><span class="eyebrow">Bottleneck</span>
      <p class="bneck-l">${raw(b.key ? html`<a href="#/t/${b.key}"><span class="key">${b.key}</span> ${b.title}</a>` : html`“${b.title}”`)} is holding up <b>${plural(b.holds_up, 'task')}</b>${b.quiet ? ', and nothing has moved for 2 days' : ''}.</p></div>` : '')}
    <div class="card rel-card"><div class="rel" id="rel"></div></div>
    <div class="row map-key" style="margin:14px 4px 0"><span><i class="k-wait"></i>Waits on</span><span><i class="k-sub"></i>Sub-task of</span><span><i class="k-met"></i>Cleared lately</span>
      <span><i class="k-cond"></i>A condition</span><span><i class="k-bn"></i>Bottleneck</span><span class="muted">Tap a task to open it.</span></div>`;
  bind($app, {
    only: (el) => { briefProject.set(el.dataset.k); viewRelations(); },
    subs: (el) => { relSubs = el.checked; try { localStorage.setItem('kunla.relSubs', relSubs ? '1' : '0'); } catch {} viewRelations(focus); },
  });
  drawRelations(g, focus);
}

function drawRelations(g, focus) {
  const box = $('rel');
  if (!g.nodes.length) {
    box.innerHTML = html`<div class="rel-empty"><h2>Nothing waits on anything${focus ? ` around ${focus}` : ''}</h2><p class="muted">On a task, add what it waits on: another task, a PR link, or what has to be true. Agents do it with <code>waiting_on</code> when they split work, and next_task holds the waiting task back until it can start.</p></div>`;
    return;
  }
  const W = innerWidth < 700 ? 168 : 196, H = 84, GX = innerWidth < 700 ? 36 : 46, GY = 14, GC = 30, PAD = 16;
  const ids = g.nodes.map((n) => n.id);
  const ins = new Map(ids.map((i) => [i, []])), outs = new Map(ids.map((i) => [i, []]));
  for (const e of g.edges) { ins.get(e.to)?.push(e.from); outs.get(e.from)?.push(e.to); }
  // Columns: the longest chain of waits leading into each node (a guard stops at the node count).
  const layer = new Map();
  const depth = (n, seen = new Set()) => {
    if (layer.has(n)) return layer.get(n);
    if (seen.has(n) || seen.size > ids.length) return 0;
    seen.add(n);
    const d = Math.max(-1, ...ins.get(n).map((p) => depth(p, seen))) + 1;
    layer.set(n, d); return d;
  };
  ids.forEach((n) => depth(n));
  // Something nothing waits for sits just before what it unblocks, not far left, so its arrow stays short.
  for (let pass = 0; pass < 3; pass++) for (const n of ids) {
    if (ins.get(n).length || !outs.get(n).length) continue;
    layer.set(n, Math.max(0, Math.min(...outs.get(n).map((o) => layer.get(o))) - 1));
  }
  // Connected pieces are drawn one under the other, the biggest first.
  const comp = new Map(); let ci = 0;
  for (const n of ids) {
    if (comp.has(n)) continue;
    const st = [n];
    while (st.length) { const x = st.pop(); if (comp.has(x)) continue; comp.set(x, ci); st.push(...ins.get(x), ...outs.get(x)); }
    ci++;
  }
  const comps = [...Array(ci).keys()].map((c) => ids.filter((n) => comp.get(n) === c)).sort((a, b) => b.length - a.length);
  const pos = new Map();
  let top = PAD, maxCol = 0;
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  for (const members of comps) {
    const cols = [];
    for (const n of members) { const l = layer.get(n); (cols[l] = cols[l] || []).push(n); }
    for (const col of cols) col?.sort((a, b) => (byId.get(b).holds_up - byId.get(a).holds_up) || String(a).localeCompare(String(b), undefined, { numeric: true }));
    // Two passes: place each node near the middle of what it waits on, so arrows cross less.
    const rowOf = new Map();
    cols.forEach((col) => col?.forEach((n, i) => rowOf.set(n, i)));
    for (let pass = 0; pass < 2; pass++) for (let l = 1; l < cols.length; l++) {
      const col = cols[l]; if (!col) continue;
      const bary = (n) => { const p = ins.get(n).filter((x) => rowOf.has(x) && layer.get(x) < l); return p.length ? p.reduce((s, x) => s + rowOf.get(x), 0) / p.length : rowOf.get(n); };
      col.sort((a, b) => bary(a) - bary(b));
      col.forEach((n, i) => rowOf.set(n, i));
    }
    const rows = Math.max(...cols.map((c) => c?.length || 0));
    cols.forEach((col, l) => col?.forEach((n, i) => {
      const off = (rows - col.length) * (H + GY) / 2;
      pos.set(n, { x: PAD + l * (W + GX), y: top + off + i * (H + GY) });
    }));
    maxCol = Math.max(maxCol, cols.length);
    top += rows * (H + GY) - GY + GC;
  }
  const width = PAD * 2 + maxCol * (W + GX) - GX, height = top - GC + PAD;
  const near = new Set(focus ? [focus, ...(ins.get(focus) || []), ...(outs.get(focus) || [])] : []);
  const path = (e) => {
    const a = pos.get(e.from), b = pos.get(e.to); if (!a || !b) return '';
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x - 6, y2 = b.y + H / 2, dx = Math.max(24, (x2 - x1) / 2);
    const cls = `rel-e ${e.kind} ${e.met ? 'met' : ''} ${focus && (e.from === focus || e.to === focus) ? 'hot' : ''}`;
    return `<path class="${cls}" d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}" marker-end="url(#${e.kind === 'sub' ? 'ah-sub' : e.met ? 'ah-met' : 'ah'})"/>`;
  };
  const bn = new Set(g.bottlenecks.slice(0, 1).map((x) => x.id));
  const node = (n) => {
    const p = pos.get(n.id);
    const dim = focus && !near.has(n.id);
    const fin = ['done', 'declined', 'met'].includes(n.status);
    const tags = [n.holds_up ? `holds up ${n.holds_up}` : '', n.waiting ? `waits on ${n.waiting}` : '', n.assumptions ? `${plural(n.assumptions, 'assumption')}` : ''].filter(Boolean).join(' · ');
    const inner = n.type === 'condition'
      ? html`<span class="rel-k">Condition${n.holder ? ' · ' + n.holder.name : ''}</span><span class="rel-t">${n.title}</span><span class="rel-f">${n.status === 'met' ? 'came true' : tags || 'not yet'}${raw(n.quiet ? ' <b class="q">quiet</b>' : '')}</span>`
      : html`<span class="rel-k"><span class="st-dot s-${n.status}"></span>${n.key}${raw(n.holder ? ' · ' + esc(n.holder.name) : '')}</span><span class="rel-t">${n.title}</span><span class="rel-f">${STATUS[n.status] || n.status}${tags ? ' · ' + tags : ''}${raw(n.quiet ? ' <b class="q">quiet</b>' : '')}</span>`;
    const cls = `rel-n ${n.type} ${bn.has(n.id) ? 'bn' : ''} ${n.id === focus ? 'focus' : ''} ${dim ? 'dim' : ''} ${fin ? 'fin' : ''}`;
    const style = `left:${p.x}px;top:${p.y}px;width:${W}px;height:${H}px`;
    return n.key ? html`<a class="${cls}" href="#/t/${n.key}" style="${style}" title="${n.key} ${n.title}">${raw(inner)}</a>`
      : n.link ? html`<a class="${cls}" href="${n.link}" target="_blank" rel="noopener" style="${style}" title="${n.title}">${raw(inner)}</a>`
      : html`<div class="${cls}" style="${style}" title="${n.title}">${raw(inner)}</div>`;
  };
  const marker = (id, cls) => `<marker id="${id}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path class="${cls}" d="M0,0 L8,4 L0,8 z"/></marker>`;
  box.innerHTML = `<div class="rel-in" style="width:${width}px;height:${height}px">
    <svg class="rel-svg" width="${width}" height="${height}" aria-hidden="true"><defs>${marker('ah', 'ah')}${marker('ah-sub', 'ah sub')}${marker('ah-met', 'ah met')}</defs>${g.edges.map(path).join('')}</svg>
    ${g.nodes.map(node).join('')}</div>`;
  if (focus && pos.get(focus)) box.scrollLeft = Math.max(0, pos.get(focus).x - (box.clientWidth - W) / 2);
}

// ---------- task: review and teach ----------
const EVENT = {
  created: (e) => e.data?.status === 'inbox' ? 'proposed it' : 'wrote the brief', claimed: () => 'picked it up', work_logged: () => 'logged work',
  submitted: () => 'sent it for review', approved: (e) => (e.data?.via ? 'approved it in a chat' : 'approved it'), changes_requested: (e) => (e.data?.via ? 'sent it back in a chat' : 'sent it back'),
  decision_undone: () => 'undid a decision recorded from a chat', rule_added: () => 'taught the team a rule',
  blocked: () => 'asked a question', answered: (e) => (e.data?.via ? 'answered in a chat' : 'answered'), accepted: () => 'accepted it, so it is Ready', declined: () => 'declined it',
  parked: (e) => (e.data?.until ? `put it off until ${new Date(e.data.until).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}` : 'put it off for someday'),
  unparked: () => 'brought it back',
  released: (e) => (e.data?.to ? 'handed it on' : 'let it go, back to Ready'), taken_over: () => 'took it over',
  lease_expired: () => 'went quiet, so the claim lapsed', status: (e) => `${e.data?.via ? 'said in a chat to move it' : 'moved it'} to ${STATUS[e.data?.to] || e.data?.to}`, flagged: () => 'flagged it', note: (e) => (e.data?.kind ? 'changed the kind of work' : 'commented'),
  merged: () => 'merged the PR', merge_waiting: () => 'will merge the PR when checks pass', merge_blocked: () => 'could not merge the PR yet',
  assigned: () => 'handed it over', woke: () => 'woke the agent so it carries on', wake_failed: () => 'could not wake the agent',
  github: (e) => (e.data?.to && e.data.to !== e.data.from ? `moved it to ${STATUS[e.data.to] || e.data.to} from GitHub` : 'saw it on GitHub'),
  waiting: () => 'said what it waits on', wait_met: () => 'ticked off something it waited on', wait_removed: () => 'took a wait off',
  unblocked: () => 'cleared the way: nothing left to wait on', assumed: () => 'went ahead on an assumption',
  assumption_confirmed: () => 'confirmed the assumption', assumption_corrected: () => 'corrected an assumption and sent it back',
};
// Under a decision recorded from a chat: who recorded it, the person's words, a link to the chat, and Undo.
function viaLine(e, t, undoable) {
  const v = e.data?.via;
  if (!v) return '';
  return html`<div class="via">${raw(v.quote ? html`<q>${v.quote}</q> ` : '')}<span class="muted">Recorded by ${v.agent} from</span> <a href="${v.source_url}" target="_blank" rel="noopener">${sessionLabel(v.source_url)} ↗</a>${raw(undoable === e.id ? html` <button class="btn quiet sm" data-act="click:undodecision">Undo</button>` : '')}</div>`;
}
// A readable name for the chat or agent session a task links back to.
function sessionLabel(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'claude.ai') return u.pathname.startsWith('/code/project/') ? 'Claude project thread' : u.pathname.startsWith('/code/') ? 'Claude Code session' : u.pathname.startsWith('/project/') ? 'Claude project' : 'Claude chat';
    if (u.hostname === 'chatgpt.com' || u.hostname === 'chat.openai.com') return 'ChatGPT chat';
    return u.hostname;
  } catch { return url; }
}
async function viewTask(key) {
  renderShell('tasks');
  const t = await api('GET', `/api/tasks/${encodeURIComponent(key)}`);
  const hist = [...t.history].reverse();
  const isWorker = t.assignee?.id === me.id;
  let decision = '';
  if (t.status === 'review' && !isWorker) {
    const sub = hist.filter((e) => e.type === 'submitted').pop();
    decision = decisionCard({ kind: 'review', task: { ...t, summary: sub?.note, deliverables: t.deliverables, notes: t.notes } }, { solo: true });
  } else if (t.status === 'blocked') decision = decisionCard({ kind: 'question', task: t }, { solo: true });
  else if (t.status === 'inbox') decision = decisionCard({ kind: 'proposal', task: t }, { solo: true });
  const mark = new Set(['submitted', 'approved', 'changes_requested', 'blocked', 'answered', 'rule_added']);
  // The person can undo the last decision their agent recorded from a chat, while nothing has moved since.
  const lastDecision = t.history.find((e) => ['approved', 'changes_requested', 'answered', 'status', 'decision_undone'].includes(e.type));
  const undoable = lastDecision?.data?.via && lastDecision.actor === me.name && t.status === lastDecision.data.to ? lastDecision.id : null;
  const p = t.project ?? { key: t.workspace.key, name: t.workspace.name };
  const subs = t.subtasks;
  const subDone = subs.filter((x) => ['done', 'declined'].includes(x.status)).length;
  $app.innerHTML = html`<div class="task"><article>
      <div class="crumbs"><a href="#/tasks">${t.workspace.name}</a>${raw(t.project ? html`<span>/</span><a href="#/tasks/${p.key}">${p.name}</a>` : '')}
        ${raw(t.parent ? html`<span>/</span><a href="#/t/${t.parent.key}">${t.parent.key} ${t.parent.title}</a>` : '')}<span>/</span><span class="mono" title="${t.full_key ? `${t.full_key} from other workspaces` : ''}">${t.key}</span></div>
      <h1>${t.title}</h1>
      <div class="row">${raw(me.kind === 'human' ? statusPick(t) : html`<span class="pill ${statusTone(t.status)}">${STATUS[t.status]}</span>`)}${raw(hint(STATUS_HINT[t.status], `What ${STATUS[t.status]} means`))}
        <label class="kindpick" title="Kind of work"><span class="sr">Kind of work</span><select data-act="change:kind" aria-label="Kind of work">${join([...(t.kinds_here || []), ...((t.kinds_here || []).some((x) => x.key === t.kind) ? [] : [{ key: t.kind, label: kindName(t.kind) }])].map((x) => html`<option value="${x.key}" ${t.kind === x.key ? 'selected' : ''}>${x.label}</option>`))}</select></label>
        <div class="people"><span>${raw(who(t.assignee, 'Nobody yet'))}</span>${raw(t.reviewer ? html`<span class="muted">reviewed by</span><span>${raw(who(t.reviewer))}</span>` : '')}
        ${raw(t.created_by ? html`<span class="muted">asked by ${t.created_by.name}</span>` : '')}</div></div>
      ${raw(decision ? html`<div class="card" style="margin-top:24px">${raw(decision)}</div>` : '')}
      ${raw(claimCard(t))}
      ${raw(t.status === 'parked' ? html`<div class="card pad parked-note"><div class="grow"><b>Put off ${t.snoozed_until ? 'until ' + new Date(t.snoozed_until).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }) : 'for someday'}.</b>
        <span class="muted">It is out of the briefing and agents leave it alone. When it comes back it returns to ${STATUS[t.returns_to] || 'Ready'}.</span></div><button class="btn go" data-act="click:unpark">Bring it back</button></div>`
        : '')}
      ${raw(t.brief ? html`<div class="sec"><h3>Brief</h3><p class="prose">${prose(t.brief, t.mentions)}</p>${raw(t.mentions?.length && t.status !== 'inbox' ? html`<div class="links" aria-label="Mentioned in the brief">${join(t.mentions.map(linkPill))}</div>` : '')}</div>` : '')}
      ${raw(depsSection(t))}
      ${raw(!t.parent ? html`<div class="sec"><h3>Sub-tasks${subs.length ? ` · ${subDone} of ${subs.length} done` : ''}</h3>
        ${raw(subs.length ? html`<div class="bar" style="margin:0 0 12px">${raw(subs.length ? `<span class="b-done" style="width:${(subDone / subs.length) * 100}%"></span>` : '')}</div>
          <div class="subs">${join(subs.map((x) => html`<a href="#/t/${x.key}" class="subrow ${['done', 'declined'].includes(x.status) ? 'fin' : ''}"><span class="key">${x.key}</span><span class="t grow">${x.title}</span><span class="muted" style="font-size:13px">${x.assignee ?? ''}</span><span class="pill">${STATUS[x.status]}</span></a>`))}</div>` : '')}
        <form class="row" data-act="submit:addsub" style="margin-top:10px;flex-wrap:nowrap"><input name="title" placeholder="${subs.length ? 'Add another sub-task' : 'Split this into sub-tasks: type one and press Enter'}" aria-label="New sub-task"><button class="btn sm">Add</button></form>
        ${raw(subs.length ? '<p class="muted" style="font-size:13px;margin-top:8px">When every sub-task is finished, this task finishes on its own.</p>' : '')}</div>` : '')}
      ${raw(t.criteria.length && !(t.status === 'review' && decision) ? html`<div class="sec"><h3>Done when</h3><ul class="crit ${t.status === 'done' ? 'met' : ''}">${join(t.criteria.map((c) => html`<li>${c}</li>`))}</ul></div>` : '')}
      ${raw((t.deliverables.length || t.notes?.length) && !(t.status === 'review' && decision) ? html`<div class="sec"><h3>The work</h3>${raw(t.deliverables.length ? html`<div class="links">${join(t.deliverables.map(linkPill))}</div>` : '')}${raw(notesBlock(t.notes))}</div>` : '')}
      ${raw(t.sessions?.length ? html`<div class="sec"><h3>Worked on in</h3><div class="links">${join(t.sessions.map((x) => x.url
        ? html`<a class="pill" href="${x.url}" target="_blank" rel="noopener" title="${x.member ? x.member + ', ' : ''}${agoLong(x.created_at)}"><span class="pill-t">${sessionLabel(x.url)}${x.member ? ' · ' + x.member : ''}</span> ↗</a>`
        : html`<span class="pill" title="${x.member ? x.member + ', ' : ''}${agoLong(x.created_at)}"><code class="pill-t">${x.ref}</code></span>`))}</div></div>` : '')}
      <div class="sec"><h3>How it got here</h3><div class="trail">${join(hist.map((e) => html`<div class="ev ${mark.has(e.type) ? 'mark' : ''} ${e.type === 'rule_added' ? 'rule' : ''}">
        <span class="when">${when(e.created_at)}</span>${raw(e.actor ? av({ name: e.actor, kind: e.actor_kind }, 'sm') : '<span class="av sm">K</span>')}
        <div><div class="what">${e.actor ?? 'Kunla'} ${(EVENT[e.type] || (() => e.type))(e)}</div>${raw(e.note && e.type !== 'created' ? html`<div class="note">${prose(e.note)}</div>` : '')}${raw(viaLine(e, t, undoable))}</div></div>`))}</div></div>
      <div class="sec"><h3>Comment</h3><form class="composer" data-act="submit:comment">
        <textarea name="text" rows="3" placeholder="${t.assignee?.kind === 'ai' ? `${t.assignee.name} reads this the next time it opens ${t.key}.` : 'Add a note to the record.'}"></textarea>
        <div class="acts"><button class="btn ink">Comment</button></div>
      </form></div>
    </article>
    <aside class="aside">
      <div class="brain"><h3>Sent with this task</h3>
        ${raw(t.rules.length ? html`<ol class="rules-mini" style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:8px;font-size:14px">${join(t.rules.map((r) => html`<li>${r.text}${raw(r.project === t.workspace.key ? ' <span class="m-ws">everywhere</span>' : '')}</li>`))}</ol>` : '<p class="s" style="color:#b9b6ac;font-size:13.5px">No rules yet.</p>')}
        ${raw(t.playbook ? html`<details class="playbook"><summary>Playbook</summary><pre>${t.playbook}</pre></details>` : '')}</div>
      ${raw(t.how_to_finish && OPEN.has(t.status) ? html`<div class="card pad finish"><h3>Finished looks like</h3><p>${t.how_to_finish.hand_in.replace(/^./, (x) => x.toUpperCase())}</p><p class="muted">${t.how_to_finish.approval}</p></div>` : '')}
      <div class="card pad"><h3>Cite it anywhere</h3><div class="cite">${join((t.kind === 'code'
        ? [['Commit trailer', t.references.commit_trailer], ['Branch', t.references.branch], ['Doc source line', t.references.doc_source_line], ['Link', t.references.link], ['Key from another workspace', t.full_key]]
        : [['Doc source line', t.references.doc_source_line], ['In a message', t.references.message_line], ['Link', t.references.link], ['Commit trailer', t.references.commit_trailer], ['Key from another workspace', t.full_key]]).filter(([, v]) => v).map(([l, v]) => html`<button type="button" data-act="click:copy" data-v="${v}"><small>${l}</small><code>${v}</code></button>`))}</div></div>
    </aside></div>`;
  const reload = () => viewTask(key);
  const text = () => $app.querySelector('.composer textarea').value.trim();
  bind($app, {
    ...decisionHandlers(reload),
    later: () => showLater(t.key, reload),
    status: async (el) => {
      const to = el.value;
      if (to === t.status) return;
      if (to === 'parked') { el.value = t.status; return showLater(t.key, reload); }
      try {
        // Done from In review is an approval, so it goes through review (and merges the PR where that is the rule).
        if (to === 'done' && t.status === 'review') await api('POST', `/api/tasks/${t.key}/review`, { verdict: 'approved' });
        else await api('PATCH', `/api/tasks/${t.key}`, { status: to });
      } catch (err) { el.value = t.status; throw err; }
      toast(`${t.key} is ${STATUS[to]} now.`); reload();
    },
    kind: async (el) => { await api('PATCH', `/api/tasks/${t.key}`, { kind: el.value }); toast(`${t.key} is ${kindName(el.value).toLowerCase()} work now.`); reload(); },
    unpark: async () => { const r = await api('POST', `/api/tasks/${t.key}/unpark`); toast(`${t.key} is back in ${STATUS[r.status]}.`); reload(); },
    takeit: async () => { await api('POST', `/api/tasks/${t.key}/claim`); toast(`${t.key} is yours. Agents will skip it.`); reload(); },
    release: () => showHandoff(t, 'release', reload),
    takeover: () => showHandoff(t, 'takeover', reload),
    undodecision: async () => { const r = await api('POST', `/api/tasks/${t.key}/decision/undo`); toast(`Undone. ${t.key} is back in ${STATUS[r.status]}.`); reload(); },
    addsub: async (f) => {
      const title = formData(f).title.trim(); if (!title) return;
      const n = await api('POST', '/api/tasks', { parent: t.key, title });
      toast(`${n.key} added under ${t.key}.`); reload();
    },
    addwait: async (f) => {
      const d = formData(f); const v = (d.on || '').trim(); if (!v) return;
      const item = d.owner && !/^[A-Za-z][A-Za-z0-9]{0,9}-\d+$/.test(v) ? { condition: /^https?:/.test(v) ? undefined : v, link: /^https?:/.test(v) ? v : undefined, owner: d.owner } : v;
      await api('PATCH', `/api/tasks/${t.key}`, { waiting_on: [item] });
      toast(`${t.key} waits on that now. Agents skip it until it happens.`); reload();
    },
    waitmet: async (el) => { await api('PATCH', `/api/tasks/${t.key}`, { waits_met: [el.dataset.id] }); toast('Ticked off.'); reload(); },
    waitoff: async (el) => { await api('PATCH', `/api/tasks/${t.key}`, { not_waiting_on: [el.dataset.id] }); toast('Taken off.'); reload(); },
    comment: async (f) => { if (!text()) throw new Error('Write something first.'); await api('POST', `/api/tasks/${t.key}/comment`, { text: text() }); toast('Added to the record.'); reload(); },
    copy: async (el) => { try { await navigator.clipboard.writeText(el.dataset.v); toast('Copied.'); } catch { toast(el.dataset.v); } },
  });
  $app.querySelectorAll('textarea[name=answer]').forEach((ta) => ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ta.form.requestSubmit(); }));
}

// ---------- waiting on, what it holds up, assumptions (KD-84) ----------
// A task waits on another task, a condition (a PR merging, "budget approved") or, as before, a person's
// answer (the blocked question). Each wait names who owes it. Assumptions are what an agent went ahead on.
function depsSection(t) {
  const open = t.waiting_on || [];
  const blocks = t.blocks || [];
  const assumed = t.assumptions || [];
  const met = t.recently_met || [];
  const owner = (w) => (w.owner ? `${w.kind === 'task' ? '' : 'owed by '}${w.owner.name}` : w.kind === 'task' ? (w.task.status === 'ready' ? 'nobody on it yet' : '') : 'nobody named');
  const row = (w) => html`<div class="dep">
    ${raw(w.task ? html`<span class="st-dot s-${w.task.status}" title="${STATUS[w.task.status]}"></span><a href="#/t/${w.task.key}" class="grow"><span class="key">${w.task.key}</span> ${w.task.title}</a>`
      : html`<span class="cond-dot" aria-hidden="true"></span><span class="grow">${w.condition}${raw(w.link ? html` <a href="${w.link}" target="_blank" rel="noopener" class="muted">↗</a>` : '')}</span>`)}
    <span class="muted dep-w">${w.task ? (w.task.holder ? w.task.holder.name + ' · ' : '') + STATUS[w.task.status] : owner(w)} · ${ago(w.since)}</span>
    ${raw(w.kind === 'condition' ? html`<button class="btn sm" data-act="click:waitmet" data-id="${w.id}" title="It happened">Done</button>` : '')}
    <button class="btn sm quiet" data-act="click:waitoff" data-id="${w.id}" title="No longer waiting on this" aria-label="Stop waiting on ${w.label}">×</button></div>`;
  const people = members.filter((m) => !m.removed_at);
  const asm = (a) => html`<div class="dep asm ${a.state}"><span class="asm-k">${a.state === 'open' ? 'Assuming' : a.state === 'confirmed' ? 'Confirmed' : 'Corrected'}</span>
    <span class="grow">${a.text}${raw(a.answer ? html`<span class="asm-a">Actually: ${a.answer}</span>` : '')}</span><span class="muted dep-w">${a.made_by?.name ?? ''} · ${ago(a.at)}</span></div>`;
  return html`<div class="sec deps"><h3>Waiting on${open.length ? ` · ${open.length}` : ''}</h3>
    ${raw(open.length ? html`<div class="dep-list">${join(open.map(row))}</div>` : html`<p class="muted" style="font-size:14px">${t.status === 'blocked' ? 'Only the question above.' : 'Nothing. It can go ahead.'}</p>`)}
    ${raw(met.length ? html`<p class="muted dep-met">Cleared: ${met.map((m) => m.label).join(', ')}</p>` : '')}
    ${raw(['done', 'declined'].includes(t.status) ? '' : html`<form class="row dep-add" data-act="submit:addwait"><input name="on" placeholder="A task key, a PR link, or what has to be true" aria-label="Waits on">
      <select name="owner" aria-label="Who owes it"><option value="">Who owes it?</option>${join(people.map((m) => html`<option value="${m.name}">${m.name}</option>`))}</select><button class="btn sm">Add</button></form>`)}
    ${raw(blocks.length ? html`<h3 style="margin-top:22px">Holds up · ${blocks.length}</h3><div class="dep-list">${join(blocks.map((b) => html`<div class="dep"><span class="st-dot s-${b.status}"></span><a href="#/t/${b.key}" class="grow"><span class="key">${b.key}</span> ${b.title}</a><span class="muted dep-w">waits on this</span></div>`))}</div>` : '')}
    ${raw(assumed.length ? html`<h3 style="margin-top:22px">Assumptions</h3><div class="dep-list">${join(assumed.map(asm))}</div>` : '')}
    ${raw(open.length || blocks.length || t.subtasks?.length || t.parent ? html`<a class="dep-map muted" href="#/map/relations/${t.key}">See how it connects ↗</a>` : '')}</div>`;
}

// ---------- status picker (KD-57) ----------
// People can move a task to any state they can set by hand. Waiting and In review need a question or the work,
// so they only show while the task is already there; Later… opens the put-off sheet.
const statusTone = (s) => (s === 'review' ? 'lime' : s === 'blocked' ? 'warn' : s === 'done' ? 'on' : '');
const PICKABLE = ['inbox', 'ready', 'in_progress', 'blocked', 'review', 'done', 'declined', 'parked'];
function statusPick(t) {
  const opts = PICKABLE.filter((s) => s === t.status || !['blocked', 'review'].includes(s));
  return html`<label class="statuspick ${statusTone(t.status)}" title="Change status"><span class="sr">Status</span><select data-act="change:status" aria-label="Status">${join(opts.map((s) => html`<option value="${s}" ${t.status === s ? 'selected' : ''}>${s === 'parked' && t.status !== 'parked' ? 'Later…' : STATUS[s]}</option>`))}</select></label>`;
}

// ---------- sharing work: who holds a task, handoffs, take-overs (KD-36) ----------
// One holder per task. Agents hold a lease that lapses when they go quiet; people hold until they let go.
function claimCard(t) {
  const c = t.claim;
  const h = t.handoff;
  // The last handoff note matters to whoever picks the task up, so it shows until there's newer work on top of it.
  const showHandoff = h?.note && (t.status === 'ready' || (c && new Date(c.since) >= new Date(h.at)));
  const handoffLine = showHandoff ? html`<div class="handoff"><small>${h.type === 'taken_over' ? `${h.by} took it over${h.from ? ' from ' + h.from : ''}` : h.type === 'released' ? `Handoff from ${h.from ?? h.by}` : 'The claim lapsed'} · ${agoLong(h.at)}</small><p class="prose">${prose(h.note)}</p></div>` : '';
  if (c) {
    const lease = c.holder.kind === 'ai' && c.lease_expires_at ? `lease ends in ${span(new Date(c.lease_expires_at) - Date.now())}` : '';
    const heard = `last heard ${agoLong(c.last_heard)}`;
    const acts = c.you_hold ? '<button class="btn sm" data-act="click:release">Hand off…</button>'
      : me.kind === 'human' ? '<button class="btn sm" data-act="click:takeover">Take over…</button>' : '';
    return html`<div class="card pad claim ${c.stale ? 'stale' : ''}"><div class="grow">
      <b>${c.you_hold ? 'You hold this' : `${c.holder.name} is on it`}${raw(c.stale ? ' <span class="pill warn">quiet</span>' : '')}</b>
      <span class="muted">${c.you_hold ? (c.holder.kind === 'ai' ? '' : 'Agents skip it until you hand it off or finish. ') : (c.holder.kind === 'ai' ? 'Other agents skip it. ' : 'Agents skip it. ')}Since ${agoLong(c.since)}, ${heard}${lease ? ', ' + lease : ''}.${c.stale ? ' It stays theirs until they let go or someone takes it over.' : ''}</span>
      ${raw(handoffLine)}</div>${raw(acts)}</div>`;
  }
  if (t.status !== 'ready') return '';
  if (t.waiting) {
    const on = t.waiting_on.map((w) => w.label).join(', ');
    return html`<div class="card pad claim waitcard"><div class="grow"><b>Waiting on ${on}</b>
      <span class="muted">Agents skip it until then, and it comes back by itself. ${me.kind === 'human' ? 'You can still start it.' : ''}</span>${raw(handoffLine)}</div>
      ${raw(me.kind === 'human' ? '<button class="btn sm" data-act="click:takeit">Start anyway</button>' : '')}</div>`;
  }
  const pinned = t.assignee && t.assignee.id !== me.id;
  const acts = me.kind !== 'human' ? '' : pinned ? '<button class="btn sm" data-act="click:takeover">Take over…</button>' : '<button class="btn sm go" data-act="click:takeit">Take it</button>';
  return html`<div class="card pad claim"><div class="grow"><b>${pinned ? `Waiting for ${t.assignee.name} to pick it up` : t.assignee ? 'Handed to you' : 'Nobody is on this yet'}</b>
    <span class="muted">${pinned ? 'Only they can claim it.' : 'Whoever claims it first holds it; everyone else skips it.'}</span>${raw(handoffLine)}</div>${raw(acts)}</div>`;
}

function showHandoff(t, mode, after) {
  const others = members.filter((m) => !m.removed_at && m.id !== t.assignee?.id && (mode === 'release' ? m.id !== me.id : true));
  const release = mode === 'release';
  openSheet(html`<form class="sheet-body stack" data-act="submit:go"><div><h2>${release ? `Hand off ${t.key}` : `Take over ${t.key}`}</h2>
    <p class="muted">${release ? 'Say where the work stands. Whoever picks it up reads this first.'
      : `${t.assignee?.name ?? 'The holder'} ${t.assignee?.kind === 'ai' ? 'is told to stop and move on' : 'sees this in the record'}. The reason goes in the record.`}</p></div>
    <div class="field"><label for="ho-to">${release ? 'Give it to' : 'Who works on it'}</label><select id="ho-to" name="to">
      <option value="">${release ? 'Anyone (back to Ready)' : 'Me'}</option>
      ${join(others.filter((m) => release || m.id !== me.id).map((m) => html`<option value="${m.name}">${m.name}${m.kind === 'ai' ? ' (AI)' : ''}</option>`))}</select></div>
    <div class="field"><label for="ho-note">${release ? 'Handoff note' : 'Why (optional)'}</label><textarea id="ho-note" name="note" rows="3" ${release ? 'required' : ''} placeholder="${release ? "What's done, what's left, where the draft or branch is" : 'e.g. I need this today'}"></textarea></div>
    <div class="row"><button class="btn go">${release ? 'Hand off' : 'Take over'}</button><button type="button" class="btn quiet" data-act="click:close">Cancel</button></div></form>`, {
    go: async (f) => {
      const d = formData(f);
      const r = await api('POST', `/api/tasks/${t.key}/${release ? 'release' : 'takeover'}`, { note: d.note.trim(), to: d.to || null });
      closeSheet(true);
      toast(r.assignee_id === me.id ? `${t.key} is yours now.` : d.to ? `${t.key} is with ${d.to}.` : `${t.key} is back in Ready.`);
      await after();
    },
  });
}

// ---------- tasks: one list that stays useful at hundreds of tasks ----------
// You manage views, not lists: pick a filter and a grouping, save it, and come back to it.
const VIEWS_KEY = 'kunla.views';
const tv = { mode: 'list', group: 'project', filter: 'open', q: '', kind: '' };
try { Object.assign(tv, JSON.parse(localStorage.getItem('kunla.tv') || '{}')); } catch {}
const saveTv = () => { try { localStorage.setItem('kunla.tv', JSON.stringify({ mode: tv.mode, group: tv.group, filter: tv.filter, kind: tv.kind })); } catch {} };
const savedViews = () => { try { return JSON.parse(localStorage.getItem(VIEWS_KEY) || '[]'); } catch { return []; } };
const OPEN = new Set(['inbox', 'ready', 'in_progress', 'blocked', 'review']);
const DAY = 86400000;
const FILTERS = {
  open: ['Open', (t) => OPEN.has(t.status)],
  later: ['Later', (t) => t.status === 'parked'],
  mine: ['Mine', (t) => OPEN.has(t.status) && (t.assignee?.id === me.id || t.reviewer?.id === me.id || (t.created_by?.id === me.id && !t.assignee))],
  stuck: ['Stuck', (t) => t.status === 'blocked' || (OPEN.has(t.status) && t.review_rounds >= 2)
    || (t.status === 'in_progress' && Date.now() - new Date(t.updated_at) > 2 * DAY) || (t.status === 'ready' && !t.assignee && Date.now() - new Date(t.updated_at) > 7 * DAY)],
  week: ['Done this week', (t) => t.status === 'done' && Date.now() - new Date(t.updated_at) < 7 * DAY],
  all: ['Everything', () => true],
};
const FILTER_HINT = 'Open: everything not finished (Proposed, Ready, In progress, Waiting, In review).\nLater: put off on purpose.\nMine: yours to do or review, or asked by you and nobody has it.\nStuck: waiting on an answer, sent back twice, in progress with no news for 2 days, or Ready with nobody for a week.\nDone this week: finished in the last 7 days.';
const GROUPS = { project: 'Project', person: 'Person', status: 'Status', kind: 'Kind' };
const STATUS_ORDER = ['blocked', 'review', 'in_progress', 'ready', 'inbox', 'parked', 'done', 'declined'];

// Tasks narrowed to one project (KD-82), like the Briefing (KD-81): a picker beside "All kinds".
// The project lives in the address (#/tasks/KD) so saved views and links keep working; the last pick is
// remembered per workspace, so opening Tasks again lands on it. Picking All projects forgets it.
const TASKS_PROJECT_KEY = 'kunla.tasksProject';
const tasksProject = {
  get: () => { try { return JSON.parse(localStorage.getItem(TASKS_PROJECT_KEY) || '{}')[me.workspace.key] || ''; } catch { return ''; } },
  set: (k) => { try { const all = JSON.parse(localStorage.getItem(TASKS_PROJECT_KEY) || '{}'); if (k) all[me.workspace.key] = k; else delete all[me.workspace.key]; localStorage.setItem(TASKS_PROJECT_KEY, JSON.stringify(all)); } catch {} },
};
const projectChoices = () => [...projects.filter((x) => x.key !== me.workspace.key).map((x) => [x.key, x.name]), [me.workspace.key, 'No project']];

async function viewTasks(project) {
  if (!project) {
    const kept = tasksProject.get();
    if (kept && projectChoices().some(([k]) => k === kept)) { history.replaceState(null, '', `#/tasks/${kept}`); project = kept; }
    else if (kept) tasksProject.set('');
  } else if (projectChoices().some(([k]) => k === project)) tasksProject.set(project);
  renderShell('tasks');
  const all = await api('GET', `/api/tasks?limit=1000${project ? '&project=' + project : ''}`);
  if (me.kind === 'human' && !members.length) members = await api('GET', '/api/members').catch(() => []);
  const readyFree = all.filter((t) => t.status === 'ready' && !t.assignee).length;
  const p = projects.find((x) => x.key === project) || (project === me.workspace.key ? { key: project, name: 'No project' } : null);
  const draw = () => {
    const ql = tv.q.trim().toLowerCase();
    if (tv.kind && !KIND[tv.kind]) tv.kind = '';
    const pass = (t) => FILTERS[tv.filter][1](t) && (!tv.kind || t.kind === tv.kind) && (!ql || t.key.toLowerCase().includes(ql) || t.title.toLowerCase().includes(ql) || (t.assignee?.name ?? '').toLowerCase().includes(ql));
    const shown = all.filter(pass);
    const keys = new Set(shown.map((t) => t.key));
    const counts = Object.fromEntries(Object.keys(FILTERS).map((k) => [k, all.filter(FILTERS[k][1]).length]));
    const views = savedViews();
    const head = html`<div class="head"><div><h1>${p ? p.name : 'Tasks'}</h1><p class="sub">${p ? '' : 'Every task in the workspace. '}Agents move these themselves; you choose what to look at.</p></div>
        <button class="btn go" data-act="click:new">New task <kbd>⌘K</kbd></button></div>
      <div class="toolbar">
        <div class="row">${join(Object.entries(FILTERS).map(([k, [label]]) => html`<button class="pill ${tv.filter === k ? 'on' : ''}" data-act="click:filter" data-k="${k}">${label} <span class="mono" style="opacity:.6">${counts[k]}</span></button>`))}${raw(hint(FILTER_HINT, 'What these filters mean'))}</div>
        <div class="row" style="margin-left:auto">
          <input class="search" placeholder="Filter by words, key or person" value="${tv.q}" data-act="input:q" aria-label="Filter">
          <select data-act="change:projf" aria-label="Project"><option value="">All projects</option>${join(projectChoices().map(([k, n]) => html`<option value="${k}" ${project === k ? 'selected' : ''}>${n}</option>`))}</select>
          <select data-act="change:kindf" aria-label="Kind of work"><option value="">All kinds</option>${join(Object.entries(KIND).filter(([k]) => all.some((t) => t.kind === k)).sort((a, b) => a[1].localeCompare(b[1])).map(([k, l]) => html`<option value="${k}" ${tv.kind === k ? 'selected' : ''}>${l} · ${all.filter((t) => t.kind === k && FILTERS[tv.filter][1](t)).length}</option>`))}</select>
          ${raw(tv.mode === 'list' ? html`<select data-act="change:group" aria-label="Group by">${join(Object.entries(GROUPS).map(([k, l]) => html`<option value="${k}" ${tv.group === k ? 'selected' : ''}>Group by ${l.toLowerCase()}</option>`))}</select>` : '')}
          <div class="seg-toggle"><button class="${tv.mode === 'list' ? 'on' : ''}" data-act="click:mode" data-m="list">List</button><button class="${tv.mode === 'board' ? 'on' : ''}" data-act="click:mode" data-m="board">Board</button></div>
        </div></div>
      <div class="row" style="margin:-4px 0 18px">${raw(!project ? '' : html`<button class="pill" data-act="click:allProjects">← All tasks</button>`)}
        ${join(views.map((v, i) => html`<span class="pill saved"><a href="${v.hash}" data-act="click:view" data-i="${i}">${v.name}</a><button data-act="click:unsave" data-i="${i}" aria-label="Forget ${v.name}">×</button></span>`))}
        <button class="pill" data-act="click:save" style="border-style:dashed">+ Save this view</button>
        ${raw(me.kind === 'human' ? html`<button class="pill ${sel.on ? 'on' : ''}" data-act="click:selectMode">${sel.on ? 'Done selecting' : 'Select to hand over'}</button>` : '')}</div>
      ${raw(continuousNudge(readyFree))}`;
    let body;
    if (tv.mode === 'board') {
      const cols = [['inbox', 'Proposed'], ['ready', 'Ready'], ['in_progress', 'In progress'], ['blocked', 'Waiting'], ['review', 'In review'], ['done', 'Done']];
      body = html`<div class="cols">${join(cols.map(([s, label]) => { const list = shown.filter((t) => t.status === s); return html`<section class="col"><h3><span>${label}</span><span class="n">${list.length}</span>${raw(hint(STATUS_HINT[s], `What ${label} means`))}</h3>
        <div class="list">${raw(list.length ? list.slice(0, 60).map(tcard).join('') + (list.length > 60 ? `<div class="empty-col">${list.length - 60} more. Narrow the filter.</div>` : '') : '<div class="empty-col">None</div>')}</div></section>`; }))}</div>`;
    } else {
      // Top-level rows are tasks whose parent is not shown; sub-tasks nest under their parent.
      const tops = shown.filter((t) => !t.parent || !keys.has(t.parent));
      const kids = (k) => shown.filter((t) => t.parent === k);
      const groupOf = (t) => tv.group === 'project' ? (t.project ?? '') : tv.group === 'person' ? (t.assignee?.name ?? '') : tv.group === 'kind' ? (t.kind || 'other') : t.status;
      const order = tv.group === 'project' ? [...projects.map((x) => x.key), ''] : tv.group === 'status' ? STATUS_ORDER : tv.group === 'kind' ? Object.keys(KIND).filter((k) => k !== 'other').concat('other') : null;
      const gkeys = [...new Set(tops.map(groupOf))].sort((a, b) => order ? order.indexOf(a) - order.indexOf(b) : (a || '~').localeCompare(b || '~'));
      const label = (g) => {
        if (tv.group === 'project') { const pr = projects.find((x) => x.key === g); return pr ? html`${raw(pr.focus ? '<span class="focus-dot"></span>' : '')}${pr.name} <span class="key">${pr.key}</span>${raw(pr.ends_at ? ` <span class="muted" style="font-weight:400;font-size:13px">${esc(endsIn(pr.ends_at))}</span>` : '')}` : 'No project'; }
        if (tv.group === 'person') return g || 'Nobody yet';
        if (tv.group === 'kind') return kindName(g);
        return html`${STATUS[g]} ${raw(hint(STATUS_HINT[g], `What ${STATUS[g]} means`))}`;
      };
      body = gkeys.length ? join(gkeys.map((g) => { const rows = tops.filter((t) => groupOf(t) === g); return html`<section class="card group"><h2>${raw(label(g))} <span class="muted mono" style="font-size:12px;font-weight:400">${rows.length}</span></h2>
        <div class="rows">${join(rows.slice(0, 200).map((t) => trow(t) + kids(t.key).map((k) => trow(k, true)).join('')))}${raw(rows.length > 200 ? `<p class="muted pad">${rows.length - 200} more. Narrow the filter.</p>` : '')}</div></section>`; }))
        : raw(`<div class="card clear"><h2>Nothing here</h2><p class="muted">${tv.filter === 'stuck' ? 'Nothing is stuck. Good.' : 'Try another filter.'}</p></div>`);
    }
    // Redrawing replaces the board, which would snap its columns back to the start; keep the reader where they were.
    const redraw = !!$app.querySelector('.tlist'), keepLeft = $app.querySelector('.tlist .cols')?.scrollLeft || 0, keepY = window.scrollY;
    $app.innerHTML = head + `<div class="tlist ${sel.on ? 'selecting' : ''}">${body.__raw ?? body}</div>` + (sel.on ? selBar(shown) : '');
    const board = $app.querySelector('.tlist .cols');
    if (board && keepLeft) board.scrollLeft = keepLeft;
    if (redraw) window.scrollTo(window.scrollX, keepY);
    bind($app, {
      new: () => openPalette(p && project !== me.workspace.key ? `#${p.key} ` : ''),
      ...nudgeHandlers(readyFree, draw),
      selectMode: async () => { sel.on = !sel.on; sel.keys.clear(); if (sel.on && !members.length) members = await api('GET', '/api/members').catch(() => []); draw(); },
      selAll: () => { shown.filter((t) => t.status === 'ready').forEach((t) => sel.keys.add(t.key)); draw(); },
      selNone: () => { sel.keys.clear(); draw(); },
      selTo: () => draw.keepTo(),
      handOver: async (el) => {
        const to = $('sel-to')?.value, contRow = $('sel-cont-row'), cont = !!(contRow && !contRow.hidden && $('sel-cont')?.checked);
        if (!to) return toast('Pick who should do them.');
        el.disabled = true;
        try {
          const r = await api('POST', '/api/tasks/assign', { keys: [...sel.keys], to, continuous: cont });
          const skipped = r.skipped.length ? ` Skipped ${r.skipped.map((x) => `${x.key} (${x.reason})`).join(', ')}.` : '';
          const ai = r.to.kind === 'ai';
          toast(`${plural(r.assigned.length, 'task')} handed to ${r.to.name}${ai ? (r.continuous?.on ? ', now in continuous mode' : '; it takes them before other work') : ''}.${skipped}`);
          sel.keys.clear(); sel.on = false; sel.to = to;
          all.splice(0, all.length, ...(await api('GET', `/api/tasks?limit=1000${project ? '&project=' + project : ''}`)));
          if (ai) members = await api('GET', '/api/members').catch(() => members);
          draw();
        } finally { el.disabled = false; }
      },
      filter: (el) => { tv.filter = el.dataset.k; saveTv(); draw(); },
      mode: (el) => { tv.mode = el.dataset.m; saveTv(); draw(); },
      group: (el) => { tv.group = el.value; saveTv(); draw(); },
      kindf: (el) => { tv.kind = el.value; saveTv(); draw(); },
      projf: (el) => { tasksProject.set(el.value); location.hash = el.value ? `#/tasks/${el.value}` : '#/tasks'; },
      allProjects: () => { tasksProject.set(''); location.hash = '#/tasks'; },
      q: (el) => { tv.q = el.value; clearTimeout(draw.t); draw.t = setTimeout(() => { draw(); const i = $app.querySelector('.search'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 180); },
      save: () => {
        const name = prompt('Name this view', `${FILTERS[tv.filter][0]}${tv.kind ? ' · ' + KIND[tv.kind] : ''}${p ? ' · ' + p.name : ''}${tv.q ? ' · ' + tv.q : ''}`);
        if (!name) return;
        const list = savedViews(); list.push({ name, hash: location.hash || '#/tasks', mode: tv.mode, group: tv.group, filter: tv.filter, q: tv.q, kind: tv.kind });
        try { localStorage.setItem(VIEWS_KEY, JSON.stringify(list)); } catch {}
        toast(`Saved “${name}”.`); draw();
      },
      view: (el) => { const v = savedViews()[Number(el.dataset.i)]; tasksProject.set(v.hash.split('/')[2] || ''); Object.assign(tv, { mode: v.mode, group: v.group, filter: v.filter, q: v.q || '', kind: v.kind || '' }); saveTv(); if (location.hash === v.hash) draw(); else location.hash = v.hash; },
      unsave: (el) => { const list = savedViews(); list.splice(Number(el.dataset.i), 1); try { localStorage.setItem(VIEWS_KEY, JSON.stringify(list)); } catch {} draw(); },
    });
  };
  draw.keepTo = () => { sel.to = $('sel-to')?.value; const m = members.find((x) => x.id === sel.to); const c = $('sel-cont-row'); if (c) c.hidden = !(m?.kind === 'ai' && canManage(m) && !contOn(m)); };
  // In select mode a tap ticks a Ready task instead of opening it.
  $app.onclick = (e) => {
    if (!sel.on || !location.hash.startsWith('#/tasks')) return;
    const a = e.target.closest?.('a[data-key]');
    if (!a || !$app.contains(a)) return;
    e.preventDefault();
    if (!a.classList.contains('pickable')) return toast('Only Ready tasks can be handed over.');
    const k = a.dataset.key;
    if (sel.keys.has(k)) sel.keys.delete(k); else sel.keys.add(k);
    draw();
  };
  draw();
}

// Batch hand-over (KD-43): in select mode, Ready tasks can be ticked and handed to one member at once.
const sel = { on: false, keys: new Set(), to: null };
const pickCls = (t) => (sel.on ? (t.status === 'ready' ? 'pickable' : 'unpickable') + (sel.keys.has(t.key) ? ' picked' : '') : '');
const pickMark = (t) => (sel.on && t.status === 'ready' ? '<span class="pickbox" aria-hidden="true"></span>' : '');

/** The bar under a selection: who gets them, and continuous mode for an agent you sponsor. */
function selBar(shown) {
  const n = sel.keys.size;
  const agents = members.filter((m) => m.kind === 'ai'), humans = members.filter((m) => m.kind !== 'ai');
  const pick = members.find((m) => m.id === sel.to) || bestAgent(agents.filter(canManage)) || agents[0] || humans[0];
  const showCont = pick && pick.kind === 'ai' && canManage(pick) && !contOn(pick);
  const ready = shown.filter((t) => t.status === 'ready').length;
  const opt = (m) => html`<option value="${m.id}" ${pick && m.id === pick.id ? 'selected' : ''}>${m.name}${m.kind === 'ai' && contOn(m) ? ' · continuous' : ''}</option>`;
  return html`<div class="selbar card" role="region" aria-label="Hand over selected tasks">
    <div class="row" style="gap:12px"><b>${n ? plural(n, 'task') + ' selected' : 'Tap Ready tasks to select them'}</b>
      ${raw(ready ? html`<button class="linkish" data-act="click:selAll">All Ready here (${ready})</button>` : '')}${raw(n ? '<button class="linkish" data-act="click:selNone">Clear</button>' : '')}</div>
    <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
      <label for="sel-to" class="muted" style="font-size:14px">Hand to</label>
      <select id="sel-to" data-act="change:selTo">${raw(agents.length ? html`<optgroup label="Agents">${join(agents.map(opt))}</optgroup>` : '')}${raw(humans.length ? html`<optgroup label="People">${join(humans.map(opt))}</optgroup>` : '')}</select>
      <label id="sel-cont-row" class="row" style="gap:6px;font-size:14px" ${showCont ? '' : 'hidden'}><input type="checkbox" id="sel-cont" checked> and let it work through them (continuous mode, up to ${CONT_DEFAULTS.max_tasks_per_day} a day)</label>
      <button class="btn go sm" data-act="click:handOver" ${n ? '' : 'disabled'}>Hand over</button>
    </div></div>`;
}

function tcard(t) {
  return html`<a class="card tcard ${pickCls(t)}" href="#/t/${t.key}" data-key="${t.key}">${raw(pickMark(t))}<span class="key">${t.key}${t.parent ? ' · under ' + t.parent : ''}</span><span class="t">${raw(kindChip(t.kind))}${t.title}${raw(t.waiting ? ' <span class="waitchip">waits</span>' : '')}</span>
    <span class="f">${raw(who(t.assignee, t.status === 'ready' ? 'Anyone' : '—'))}<span class="key">${t.subtasks ? `${t.subtasks.done}/${t.subtasks.total} · ` : ''}${ago(t.updated_at)}</span></span></a>`;
}
function trow(t, child = false) {
  return html`<a class="trow ${child ? 'child' : ''} ${pickCls(t)}" href="#/t/${t.key}" data-key="${t.key}"><span class="st-dot s-${t.status}" title="${STATUS[t.status]}"></span><span class="key">${t.key}</span>
    <span class="t">${raw(tv.group === 'kind' ? '' : kindChip(t.kind))}${t.title}${raw(t.subtasks ? ` <span class="subcount">${t.subtasks.done}/${t.subtasks.total}</span>` : '')}${raw(t.waiting ? ' <span class="waitchip" title="Waits on something; agents skip it until then">waits</span>' : '')}</span>
    <span class="stx">${STATUS[t.status]}</span><span class="w">${raw(who(t.assignee, t.status === 'ready' ? 'Anyone' : ''))}</span><span class="key">${ago(t.updated_at)}</span></a>`;
}

// ---------- team ----------
const canManage = (m) => me.kind === 'human' && (me.roles?.includes('admin') || m.sponsor_id === me.id || m.id === me.id);

// Continuous mode on the agent card: running or why it stopped, and today's use against its limits.
const STOP_LABEL = {
  nothing_ready: 'nothing ready in its lane', waiting_on_people: 'everything waits on a person', tasks_budget: 'daily task limit reached',
  cost_budget: 'daily cost limit reached', tokens_budget: 'daily token limit reached', review_limit: 'too much waiting for review', ended: 'end time passed',
};
function continuousLine(m) {
  const c = m.continuous;
  if (!c?.settings?.on) return m.kind === 'ai' && canManage(m) ? html`<div class="continuous off"><b>Continuous</b> · off <button class="linkish" data-act="click:contOffer" data-id="${m.id}">Let it work through Ready tasks</button></div>` : '';
  const s = c.settings, u = c.usage || {};
  const reason = c.limit || (c.run?.state === 'stopped' ? c.run.reason : null);
  const state = c.run?.state === 'woken' && !c.limit ? 'woken for new work' : reason ? `stopped: ${STOP_LABEL[reason] || reason}${stuckAgent(m) ? '; start it again yourself (no wake-up URL)' : ''}` : c.run ? 'running' : m.wake ? 'on, Kunla starts it when work is Ready' : 'on, waiting for you to start it';
  const parts = [`${u.tasks_today ?? 0}${s.max_tasks_per_day != null ? '/' + s.max_tasks_per_day : ''} tasks today`];
  if (s.max_cost_per_day != null || u.cost_today) parts.push(`$${u.cost_today ?? 0}${s.max_cost_per_day != null ? '/$' + s.max_cost_per_day : ''}`);
  if (s.max_tokens_per_day != null || u.tokens_today) parts.push(`${u.tokens_today ?? 0}${s.max_tokens_per_day != null ? '/' + s.max_tokens_per_day : ''} tokens`);
  if (s.max_in_review != null) parts.push(`${u.in_review ?? 0}/${s.max_in_review} in review`);
  return html`<div class="continuous ${reason ? 'stopped' : 'running'}"><b>Continuous</b> · ${state}<div class="muted">${parts.join(' · ')}</div></div>`;
}

async function viewTeam(sub) {
  renderShell('team');
  const [record, pulse] = await Promise.all([api('GET', '/api/members'), api('GET', '/api/pulse')]);
  members = record;
  const ps = new Map(pulse.map((p) => [p.id, p]));
  $app.innerHTML = html`<div class="head"><div><h1>Team</h1><p class="sub">People and agents side by side. Each agent works under its own name, with a person who sponsors it. Lanes keep each one on the projects you choose.</p></div>
      <div class="row"><button class="btn go" data-act="click:connect">Connect an agent</button><button class="btn" data-act="click:claudeai">Use in claude.ai</button><button class="btn" data-act="click:addPerson">Add a person</button>${raw(me.roles?.includes('admin') ? '<button class="btn" data-act="click:github">Connect GitHub</button>' : '')}<button class="btn" data-act="click:billing" id="billing-btn" hidden>Plan and billing</button></div></div>
    <div class="people-grid">${join(record.map((m) => { const p = ps.get(m.id) || {}; return html`<div class="card pad member">
      <div class="row" style="flex-wrap:nowrap">${raw(av(m, 'lg', p.live))}<div class="grow"><div class="nm">${m.name}</div><div class="muted" style="font-size:13px">${kindLine(m)}</div></div><span class="state ${p.state || 'idle'}">${p.state || 'idle'}</span></div>
      <div style="font-size:14px;color:var(--ink-2);min-height:21px">${raw(p.task ? html`<a href="#/t/${p.task.key}">${p.line}</a>` : esc(m.last_active ? `Last active ${agoLong(m.last_active)}` : 'Not active yet'))}</div>
      ${raw(continuousLine(m))}
      <div class="stats"><div><b>${m.done}</b><small>done</small></div><div><b>${m.first_pass_rate == null ? '–' : m.first_pass_rate + '%'}</b><small>first try</small></div><div><b>${m.active}</b><small>active</small></div></div>
      ${raw(projects.length ? html`<div><div class="label" style="margin-bottom:6px">Works on</div><div class="row lanepick" data-id="${m.id}">
        <button class="pill ${m.scope.length ? '' : 'on'}" data-act="click:lane" data-k="">Everything</button>${join(projects.map((x) => html`<button class="pill ${m.scope.includes(x.key) ? 'on' : ''}" data-act="click:lane" data-k="${x.key}">${x.key}</button>`))}</div></div>` : '')}
      ${raw(canManage(m) ? html`<div><button class="btn sm" data-act="click:manage" data-id="${m.id}">Manage</button></div>` : '')}</div>`; }))}</div>`;
  bind($app, {
    connect: () => showConnect('ai'), addPerson: () => showConnect('human'), claudeai: showClaudeAi, github: showGitHub,
    // Kunla Cloud: the admin's billing page at the control plane (upgrade, card, invoices, cancel).
    billing: async () => { const w = window.open('', '_blank'); try { const r = await api('GET', '/api/billing'); if (w) w.location = r.url; else location.href = r.url; } catch (e) { w?.close(); toast(e.message); } },
    contOffer: (el) => showContinuousOffer(el.dataset.id),
    manage: (el) => showManage(record.find((x) => x.id === el.dataset.id)),
    lane: async (el) => {
      const id = el.closest('.lanepick').dataset.id;
      const m = record.find((x) => x.id === id);
      const k = el.dataset.k;
      const scope = !k ? [] : m.scope.includes(k) ? m.scope.filter((x) => x !== k) : [...m.scope, k];
      const r = await api('PATCH', `/api/members/${id}`, { scope });
      toast(r.scope.length ? `${r.name} now only picks up work in ${r.scope.join(', ')} (plus workspace tasks).` : `${r.name} picks up work anywhere.`);
      viewTeam();
    },
  });
  // Only a hosted Kunla has a plan to pay for, and only admins manage it.
  if (me.roles?.includes('admin')) api('GET', '/api/edition').then((e) => { const b = $('billing-btn'); if (b && e.plan) b.hidden = false; }).catch(() => {});
  // Open a linked dialog once, then drop it from the URL so a background refresh doesn't reopen it.
  const [subView, subQuery = ''] = (sub || '').split('?');
  if (sub && $('sheet').hidden) { if (subView === 'connect') showConnect('ai'); if (subView === 'claude-ai') showClaudeAi(); if (subView === 'github') showGitHub(undefined, new URLSearchParams(subQuery).get('gh')); }
  if (sub) history.replaceState(null, '', '#/team');
}

// Dialogs live outside the page, so the 30-second refresh never wipes them. A "sticky" one
// (a token shown once) closes only from its own button, not by tapping outside or Escape.
let sheetSticky = false;
function openSheet(inner, handlers = {}, { sticky = false, focus = true } = {}) {
  const s = $('sheet');
  sheetSticky = sticky;
  s.innerHTML = `<div class="pal sheet-card" role="dialog" aria-modal="true">${inner}</div>`;
  s.hidden = false;
  bind(s, {
    close: () => closeSheet(true),
    copy: async (el) => { try { await navigator.clipboard.writeText(el.dataset.v); el.textContent = 'Copied'; setTimeout(() => { el.textContent = 'Copy'; }, 1600); } catch { toast('Copy did not work here. Select the text and copy it.'); } },
    ...handlers,
  });
  if (focus) s.querySelector('input:not([type=hidden]):not([type=date])')?.focus();
}
function closeSheet(force) {
  if (sheetSticky && !force) return;
  const s = $('sheet'); s.hidden = true; s.innerHTML = ''; sheetSticky = false;
}
document.addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('sheet')?.hidden) closeSheet(); });

const copyBlock = (label, text, { secret = false } = {}) => html`<div class="stack" style="gap:6px"><div class="row" style="justify-content:space-between;align-items:center"><div class="label">${label}</div>
  <button class="btn sm" type="button" data-act="click:copy" data-v="${text}">Copy</button></div>${raw(secret ? html`<div class="secret">${text}</div>` : html`<pre class="code">${text}</pre>`)}</div>`;

function showConnect(kind) {
  const inner = kind === 'ai' ? html`<div class="sheet-body stack">
    <div><h2>Connect an agent</h2>
    <p class="muted">It joins as its own member, so its work is credited to it and you are its sponsor. Connecting again under the same name gives that agent a new token instead of adding a second one.</p></div>
    <form class="stack" data-act="submit:create"><input type="hidden" name="kind" value="ai">
      <div class="field"><label for="ca-n">Name</label><input id="ca-n" name="name" required value="${me.name}'s Claude Code"></div>
      <div class="field"><label for="ca-p">Agent</label><select id="ca-p" name="platform"><option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="other">Other MCP agent</option></select></div>
      <div class="row"><button class="btn go">Create connection</button><button class="btn quiet" type="button" data-act="click:close">Cancel</button></div></form>
    <p class="muted" style="font-size:13.5px">For claude.ai chats and Projects you don't need a token. <a href="#" data-act="click:claudeai">See how to add the connector.</a></p></div>`
    : html`<div class="sheet-body stack"><h2>Add a person</h2>
      <form class="stack" data-act="submit:create"><input type="hidden" name="kind" value="human">
      <div class="field"><label for="cp-n">Name</label><input id="cp-n" name="name" required></div>
      <div class="field"><label for="cp-e">Work email (optional)</label><input id="cp-e" name="email" type="email" autocomplete="off" placeholder="name@company.com"></div>
      <span class="muted" style="font-size:12px;margin-top:-8px">If this Kunla has Google or Microsoft sign-in, they sign in with this account instead of pasting a token.</span>
      <span class="muted" id="cp-plan" style="font-size:12px" hidden></span>
      <div class="row"><button class="btn go">Add</button><button class="btn quiet" type="button" data-act="click:close">Cancel</button></div></form></div>`;
  // Kunla Cloud: say how many seats the plan has left (KD-72). Agents never use one.
  if (kind !== 'ai') api('GET', '/api/edition').then((e) => {
    const el = $('cp-plan'); if (!el || !e.plan || e.plan.seats == null) return;
    const people = members.filter((x) => x.kind === 'human').length;
    el.textContent = `Your ${e.plan.name} plan covers ${e.plan.seats} people; this workspace has ${people}. Agents are always free.`; el.hidden = false;
  }).catch(() => {});
  openSheet(inner, {
    claudeai: showClaudeAi,
    create: async (f) => {
      const d = formData(f);
      const btn = f.querySelector('button.go'); btn.disabled = true; // one click, one connection
      try {
        const r = await api('POST', '/api/members', d);
        showToken(r, d.kind, d.platform);
        members = await api('GET', '/api/members');
        if (location.hash.startsWith('#/team')) viewTeam();
      } finally { btn.disabled = false; }
    },
  });
}

// Each workspace has its own MCP address, so chat apps that allow one connector per URL can add one per workspace.
const mcpUrl = () => `${location.origin}/mcp/${me.workspace.key}`;

function showToken(r, kind, platform) {
  const origin = location.origin;
  const head = r.reconnected
    ? html`<h2>New token for ${r.member.name}</h2><p class="muted">You already had an agent with this name, so it got a new token instead of a duplicate. Its earlier tokens still work; use Manage → New token to retire them.</p>`
    : html`<h2>${r.member.name} is in</h2><p class="muted">Copy the token now. Kunla shows it only once, so this stays open until you close it.</p>`;
  const setup = kind === 'human' ? '<p>Send it to them privately. They paste it on the sign-in page.</p>'
    : platform === 'claude-code' ? copyBlock('In your terminal', `export KUNLA_URL=${origin}\nexport KUNLA_TOKEN=${r.token}\nclaude plugin marketplace add spikinglabs/kunla\nclaude plugin install kunla@kunla`)
      + '<p class="muted" style="font-size:13.5px">From then on it picks up work with <code>/kunla:next</code>, cites the task in every commit, and records progress without being asked.</p>'
    : platform === 'codex' ? copyBlock('In your terminal', `export KUNLA_TOKEN=${r.token}\ncodex mcp add kunla --url ${mcpUrl()} --bearer-token-env-var KUNLA_TOKEN`)
      + '<p class="muted" style="font-size:13.5px">Codex reads <code>AGENTS.md</code> for the working agreement. Then ask it: “Take the next Kunla task and do it.” <a href="https://github.com/spikinglabs/kunla/blob/main/docs/agents/codex.md" target="_blank" rel="noopener">Full guide</a></p>'
    : copyBlock('MCP server', `URL     ${mcpUrl()}\nHeader  Authorization: Bearer ${r.token}`);
  openSheet(html`<div class="sheet-body stack"><div>${raw(head)}</div>${raw(copyBlock('Token', r.token, { secret: true }))}${raw(setup)}
    <div class="row"><button class="btn ink" data-act="click:close">I've saved it</button></div></div>`, {}, { sticky: true });
}

// ---------- continuous mode: offered where people need it, in plain words ----------
// People meet it on the Briefing and the Tasks page when Ready work piles up, not only in Team → Manage.
// Agents never need telling: Kunla says it in whoami, on connect and under every reply.
const CONT_DEFAULTS = { max_tasks_per_day: 10, max_in_review: 5 };
const WAKEABLE_STOP = ['nothing_ready', 'waiting_on_people', 'review_limit'];
const myAgents = () => members.filter((m) => m.kind === 'ai' && canManage(m));
const contOn = (m) => !!m.continuous?.settings?.on;
// The agent most likely to run on its own: one Kunla can wake, then Claude Code, then any.
const bestAgent = (list) => [...list].sort((a, b) => (!!b.wake - !!a.wake) || ((b.platform === 'claude-code') - (a.platform === 'claude-code')))[0];
// Stopped, can't be woken, and there is work: it needs a person to start it again.
const stuckAgent = (m) => contOn(m) && !m.wake && m.continuous?.run?.state === 'stopped' && WAKEABLE_STOP.includes(m.continuous.run.reason) && !m.continuous.limit;
const OFFER_KEY = 'kunla.contOffer';
const offerHidden = () => { try { return Date.now() - Number(localStorage.getItem(OFFER_KEY) || 0) < 3 * 86400000; } catch { return false; } };
const hideOffer = () => { try { localStorage.setItem(OFFER_KEY, String(Date.now())); } catch {} };

/** How the agent gets going, by kind of agent. Kunla can only start agents that have a wake-up URL. */
function startStory(m) {
  if (m.wake) return html`<p><b>Starts by itself.</b> ${m.name} has a wake-up URL, so Kunla starts it as soon as work is Ready, again when you review something, and each morning when the daily limit resets.</p>`;
  if (m.platform === 'claude-ai') return html`<p><b>You start it.</b> claude.ai chats only run when you write to them, so Kunla can't start ${m.name}. Open a chat with the Kunla connector and say:</p>${raw(copyBlock('Say in the chat', 'Work through my Kunla tasks.'))}<p class="muted" style="font-size:13px">It keeps going in that chat until it reaches a limit or nothing is left, and tells you why it stopped.</p>`;
  if (m.platform === 'claude-code') return html`<p><b>You start it once.</b> Run this in Claude Code in your repository. It keeps going while the session is open.</p>${raw(copyBlock('In Claude Code', '/kunla:work'))}
    <p class="muted" style="font-size:13px">To have Kunla start it by itself (when work is Ready, after your reviews, each morning), add a wake-up: a GitHub Action in the repository, about five minutes. <a href="#" data-act="click:setupWake" data-id="${m.id}">Set up wake-up</a></p>`;
  return html`<p><b>You start it once.</b> Ask it to call <code>next_task</code> and keep going until Kunla says stop. To have Kunla start it by itself, give it a wake-up URL. <a href="#" data-act="click:setupWake" data-id="${m.id}">Set up wake-up</a></p>`;
}
const KNOWS = 'You don\'t have to tell it the rules or limits. Kunla tells the agent in every reply that continuous mode is on, how much is left today, and to take the next task.';

/** The limit fields, plain words first. Empty means no limit. */
function limitFields(s) {
  const v = (x) => (x == null ? '' : x);
  const fresh = !s.on && [s.max_tasks_per_day, s.max_in_review, s.max_cost_per_day, s.max_tokens_per_day].every((x) => x == null);
  const t = fresh ? CONT_DEFAULTS.max_tasks_per_day : s.max_tasks_per_day, r = fresh ? CONT_DEFAULTS.max_in_review : s.max_in_review;
  return html`<div class="row limits" style="gap:8px;flex-wrap:wrap;align-items:flex-end">
      <div class="field" style="flex:1;min-width:130px"><label for="mc-t">New tasks a day</label><input id="mc-t" name="max_tasks_per_day" type="number" min="0" step="1" value="${v(t)}" placeholder="No limit"></div>
      <div class="field" style="flex:1;min-width:130px"><label for="mc-r">Pause at this many in review</label><input id="mc-r" name="max_in_review" type="number" min="0" step="1" value="${v(r)}" placeholder="No limit"></div>
      <div class="field" style="flex:1;min-width:130px"><label for="mc-k">Tokens a day</label><input id="mc-k" name="max_tokens_per_day" type="number" min="0" step="1000" value="${v(s.max_tokens_per_day)}" placeholder="No limit"></div>
      <div class="field" style="flex:1;min-width:130px"><label for="mc-c">Cost a day (USD)</label><input id="mc-c" name="max_cost_per_day" type="number" min="0" step="0.01" value="${v(s.max_cost_per_day)}" placeholder="No limit"></div>
    </div>
    <p class="muted" style="font-size:12.5px">Tokens and cost count what the agent reports after each task, so they can run a task over. Claude Code knows its usage; chats usually don't, so the task limit is the surer brake. Days are UTC.</p>`;
}
const limitBody = (f, on) => {
  const d = formData(f);
  return { on, max_tasks_per_day: d.max_tasks_per_day || null, max_cost_per_day: d.max_cost_per_day || null, max_tokens_per_day: d.max_tokens_per_day || null,
    max_in_review: d.max_in_review || null, ...(d.until !== undefined ? { until: d.until ? new Date(d.until).toISOString() : null } : {}) };
};

function continuousForm(m) {
  const s = m.continuous?.settings || {};
  const until = s.until ? new Date(new Date(s.until).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
  return html`<form class="stack" style="gap:8px" data-act="submit:continuous"><div class="label">Continuous mode</div>
    <p class="muted" style="font-size:13.5px">${m.name} takes the next Ready task in its lane, does it, sends it to you for review, and takes the next one. A question on one task doesn't stop it. It stops when nothing is left or it reaches a limit.</p>
    <label class="row" style="gap:8px;align-items:center"><input type="checkbox" name="on" ${s.on ? 'checked' : ''}> Work through Ready tasks on its own</label>
    ${raw(limitFields(s))}
    <div class="field"><label for="mc-u">Stop continuous mode at (optional)</label><input id="mc-u" name="until" type="datetime-local" value="${until}"></div>
    <div class="cont-how">${raw(startStory(m))}<p class="muted" style="font-size:13px">${KNOWS}</p></div>
    <div><button class="btn">Save</button></div></form>`;
}

/** "Let an agent work through these": the offer people see when Ready work piles up. */
function showContinuousOffer(pick, ready = 0) {
  const agents = myAgents();
  if (!agents.length) { location.hash = '#/team/connect'; return; }
  const m = agents.find((x) => x.id === pick) || bestAgent(agents.filter((x) => !contOn(x)).length ? agents.filter((x) => !contOn(x)) : agents);
  const s = m.continuous?.settings || {};
  openSheet(html`<div class="sheet-body stack">
    <div><h2>Let ${m.name} work through Ready tasks</h2>
    <p class="muted">${ready ? `${plural(ready, 'task is', 'tasks are')} Ready and nobody holds them. ` : ''}${m.name} takes the next one in its lane, does it, sends it to you for review, and takes the next. A question on one task doesn't stop it. You still review everything.</p></div>
    ${raw(agents.length > 1 ? html`<div class="field"><label for="co-a">Agent</label><select id="co-a" data-act="change:pick">${join(agents.map((a) => html`<option value="${a.id}" ${a.id === m.id ? 'selected' : ''}>${a.name} · ${PLATFORM[a.platform] || 'agent'}${contOn(a) ? ' · on' : ''}${a.wake ? ' · starts by itself' : ''}</option>`))}</select></div>` : '')}
    <form class="stack" style="gap:8px" data-act="submit:start">
      ${raw(limitFields(s))}
      <div class="cont-how">${raw(startStory(m))}<p class="muted" style="font-size:13px">${KNOWS}</p></div>
      <div class="row"><button class="btn go">${contOn(m) ? 'Save limits' : 'Start continuous mode'}</button><button class="btn quiet" type="button" data-act="click:close">Not now</button></div>
    </form></div>`, {
    pick: (el) => showContinuousOffer(el.value, ready),
    setupWake: (el) => showManage(members.find((x) => x.id === el.dataset.id)),
    start: async (f) => {
      const r = await api('PUT', `/api/members/${m.id}/continuous`, limitBody(f, true));
      m.continuous = { ...(m.continuous || {}), settings: r.continuous };
      hideOffer();
      openSheet(html`<div class="sheet-body stack"><div><h2>${m.name} is in continuous mode</h2>
        <p class="muted">Up to ${r.continuous.max_tasks_per_day ?? 'any number of'} new tasks a day${r.continuous.max_in_review != null ? `, pausing when ${r.continuous.max_in_review} wait for your review` : ''}${r.continuous.max_tokens_per_day != null ? `, ${r.continuous.max_tokens_per_day} tokens` : ''}${r.continuous.max_cost_per_day != null ? `, $${r.continuous.max_cost_per_day}` : ''}. Change it any time in Team → Manage.</p></div>
        <div class="cont-how">${raw(startStory(m))}<p class="muted" style="font-size:13px">${KNOWS}</p></div>
        <div class="row"><button class="btn ink" data-act="click:close">Done</button></div></div>`, { setupWake: (el) => showManage(members.find((x) => x.id === el.dataset.id)) });
      route();
    },
  }, { focus: false });
}

/** The nudge on the Briefing and the Tasks page: only when there is Ready work nobody holds and an agent could take it. */
function continuousNudge(readyFree) {
  if (me.kind !== 'human' || readyFree < 2 || offerHidden()) return '';
  const agents = myAgents();
  if (!agents.length) return '';
  const stuck = agents.find(stuckAgent);
  if (stuck) return html`<div class="card pad nudge"><div class="grow"><b>${plural(readyFree, 'task is', 'tasks are')} Ready, but ${stuck.name} stopped and Kunla can't restart it.</b>
    <p class="muted">${stuck.platform === 'claude-ai' ? 'Chats only run when you write to them. Ask it to work through your Kunla tasks.' : 'It has no wake-up URL. Start it again, or set up wake-up so it starts by itself.'}</p></div>
    <div class="row"><button class="btn sm ink" data-act="click:contOffer" data-id="${stuck.id}">How to start it</button><button class="btn sm quiet" data-act="click:contHide">Not now</button></div></div>`;
  if (agents.some(contOn)) return '';
  const m = bestAgent(agents);
  return html`<div class="card pad nudge"><div class="grow"><b>${plural(readyFree, 'task is', 'tasks are')} Ready and nobody has picked ${readyFree === 1 ? 'it' : 'them'} up.</b>
    <p class="muted">Let ${m.name} work through them one by one, up to ${CONT_DEFAULTS.max_tasks_per_day} a day. You still review everything.</p></div>
    <div class="row"><button class="btn sm go" data-act="click:contOffer" data-id="${m.id}">Let it work through them</button><button class="btn sm quiet" data-act="click:contHide">Not now</button></div></div>`;
}
const nudgeHandlers = (readyFree, again) => ({
  contOffer: (el) => showContinuousOffer(el.dataset.id, readyFree),
  contHide: () => { hideOffer(); toast('Hidden for three days. Team → Manage has it any time.'); again(); },
});

function showManage(m) {
  const self = m.id === me.id;
  openSheet(html`<div class="sheet-body stack">
    <div><h2>${m.name}</h2><p class="muted">${kindLine(m)}</p></div>
    <form class="stack" data-act="submit:rename"><div class="field"><label for="mm-n">Name</label><input id="mm-n" name="name" required value="${m.name}" maxlength="80"></div>
      <div><button class="btn">Save name</button></div></form>
    ${raw(m.kind === 'human' && me.roles?.includes('admin') ? html`<form class="stack" style="gap:6px" data-act="submit:email"><div class="field"><label for="mm-e">Work email</label><input id="mm-e" name="email" type="email" autocomplete="off" placeholder="name@company.com" value="${m.email || ''}"></div>
      <p class="muted" style="font-size:13.5px">${self ? 'You' : m.name} can sign in with the Google or Microsoft account for this email, when this Kunla has that sign-in set up.</p>
      <div><button class="btn">Save email</button></div></form>` : '')}
    <div class="stack" style="gap:6px"><div class="label">Token</div>
      <p class="muted" style="font-size:13.5px">${self ? 'Get a new personal token. Your old one stops working everywhere, and this browser switches to the new one.' : 'Get a new token if the old one leaked or you set it up somewhere else. Every old token for this agent stops working at once.'}</p>
      <div><button class="btn" data-act="click:rotate">New token</button></div></div>
    ${raw(m.kind === 'ai' ? html`<form class="stack" style="gap:6px" data-act="submit:wake"><div class="label">Wake it up</div>
      <p class="muted" style="font-size:13.5px">When you approve, send back, answer or hand ${m.name} a task, Kunla calls this URL so it carries on by itself. Chats (claude.ai) can't be woken. For Claude Code: copy <a href="https://github.com/spikinglabs/kunla/blob/main/examples/kunla-wake.yml" target="_blank" rel="noopener">kunla-wake.yml</a> into <code>.github/workflows/</code>, then paste your repository's dispatch URL and a GitHub token (Contents: read and write) here.</p>
      <div class="field"><label for="mw-u">Wake-up URL</label><input id="mw-u" name="url" type="url" placeholder="https://api.github.com/repos/OWNER/REPO/dispatches" value="${m.wake?.url || ''}"></div>
      <div class="field"><label for="mw-a">Token for that URL (optional)</label><input id="mw-a" name="auth" type="password" autocomplete="off" placeholder="${m.wake?.has_auth ? 'Saved. Leave empty to keep it.' : 'GitHub token, or empty'}"></div>
      <div class="row"><button class="btn">${m.wake ? 'Save' : 'Turn on'}</button>${raw(m.wake ? '<button class="btn" type="button" data-act="click:wakeTest">Send a test</button><button class="btn quiet" type="button" data-act="click:wakeOff">Turn off</button>' : '')}</div></form>` : '')}
    ${raw(m.kind === 'ai' ? continuousForm(m) : '')}
    ${raw(self ? '' : html`<div class="stack" style="gap:6px"><div class="label">Remove</div>
      <p class="muted" style="font-size:13.5px">${m.name} loses access and leaves the team list. Everything it did stays in the record under its name, and work it was holding goes back to Ready.</p>
      <div><button class="btn danger" data-act="click:remove">Remove ${m.kind === 'ai' ? 'agent' : 'person'}</button></div></div>`)}
    <div class="row"><button class="btn quiet" data-act="click:close">Close</button></div></div>`, {
    wake: async (f) => {
      const d = formData(f);
      if (!d.url) return toast('Paste a wake-up URL first.');
      if (!d.auth && m.wake?.has_auth && m.wake.url === d.url) return toast('Saved already. Paste a new token to change it.');
      const r = await api('PUT', `/api/members/${m.id}/wake`, { url: d.url, auth: d.auth || null });
      m.wake = r.callback;
      openSheet(html`<div class="sheet-body stack"><div><h2>${m.name} wakes up by itself</h2><p class="muted">Kunla signs every call with this secret (header X-Kunla-Signature-256, HMAC-SHA256 of the body). Check it if your receiver is public; GitHub's dispatch API doesn't need it. Kunla shows it only once.</p></div>
        ${raw(copyBlock('Signing secret', r.secret, { secret: true }))}<div class="row"><button class="btn ink" data-act="click:close">I've saved it</button></div></div>`, {}, { sticky: true });
    },
    continuous: async (f) => {
      const on = !!f.querySelector('[name=on]').checked;
      const r = await api('PUT', `/api/members/${m.id}/continuous`, limitBody(f, on));
      toast(r.continuous.on ? `${m.name} now works through Ready tasks one by one. Kunla tells it so in every reply.` : `Continuous mode is off for ${m.name}.`);
      closeSheet(true); viewTeam();
    },
    setupWake: () => { const el = $('mw-u'); el?.scrollIntoView({ block: 'center' }); el?.focus(); },
    wakeTest: async () => {
      const r = await api('POST', `/api/members/${m.id}/wake/test`);
      toast(r.ok ? `Test call delivered (HTTP ${r.status}).` : `Test call failed: ${r.error}.`);
    },
    wakeOff: async () => { await api('DELETE', `/api/members/${m.id}/wake`); m.wake = null; toast(`${m.name} no longer gets wake-up calls.`); closeSheet(true); viewTeam(); },
    email: async (f) => {
      const r = await api('PATCH', `/api/members/${m.id}`, { email: formData(f).email.trim() || null });
      m.email = r.email; const x = members.find((y) => y.id === m.id); if (x) x.email = r.email;
      toast(r.email ? `${m.name} can sign in as ${r.email}.` : `Email removed for ${m.name}.`);
    },
    rename: async (f) => {
      const r = await api('PATCH', `/api/members/${m.id}`, { name: formData(f).name });
      toast(`Renamed to ${r.name}.`); closeSheet(true); if (self) me.name = r.name; viewTeam();
    },
    rotate: async (el) => {
      if (el.dataset.sure !== '1') { el.dataset.sure = '1'; el.textContent = 'Old token stops working. Tap again'; return; }
      const r = await api('POST', `/api/members/${m.id}/token`);
      if (self) { token = r.token; try { localStorage.setItem(TOKEN_KEY, token); } catch {} }
      showToken({ ...r, reconnected: false, member: { ...r.member, name: `${r.member.name}: new token` } }, m.kind, m.platform);
    },
    remove: async (el) => {
      if (el.dataset.sure !== '1') { el.dataset.sure = '1'; el.textContent = `Remove ${m.name}? Tap again`; return; }
      await api('DELETE', `/api/members/${m.id}`);
      toast(`${m.name} removed.`); closeSheet(true); members = members.filter((x) => x.id !== m.id); viewTeam();
    },
  });
}

// GitHub: one click with the Kunla GitHub App (Kunla registers it through GitHub's manifest flow, the
// admin confirms on github.com and picks repositories).
const GH_BACK = {
  connected: 'Connected. Pull requests from those repositories now update their tasks.',
  updated: 'Saved your changes on GitHub.',
  expired: 'That link from GitHub was too old or already used. Tap Connect with GitHub again.',
  exists: 'The Kunla app was already set up, so nothing changed. Tap Connect with GitHub to add repositories.',
  failed: "GitHub didn't finish connecting. Tap Connect with GitHub to try again.",
};
async function showGitHub(_unused, back) {
  if (back && GH_BACK[back]) toast(GH_BACK[back]);
  const info = await api('GET', '/api/integrations/github');
  const app = info.app || {};
  const installs = app.installations || [];
  const appBlock = app.registered
    ? html`<div class="stack" style="gap:8px">
        ${raw(installs.length ? html`<div class="label">Installed on</div><ul class="hooklog">${raw(installs.map((i) => html`<li><b>${i.account || 'GitHub account'}</b><span></span><a href="${i.manage_url}" target="_blank" rel="noopener">Choose repositories</a></li>`).join(''))}</ul>` : '')}
        <div class="row"><button class="btn ${installs.length ? '' : 'go'}" data-act="click:connectApp">${installs.length ? 'Add another account' : 'Connect with GitHub'}</button></div>
        <p class="muted" style="font-size:13.5px">The ${app.name || 'Kunla'} app reads pull requests, checks and code${app.merge ? ', and writes code only to merge PRs you approve' : ''}. Nothing else.</p></div>`
    : html`<form class="stack" style="gap:8px" data-act="submit:connectApp">
        <div class="field"><label for="gh-org">GitHub organization (leave empty for your own account)</label><input id="gh-org" name="org" autocomplete="off" placeholder="e.g. acme"></div>
        <label class="row" style="gap:8px;font-size:14px"><input type="checkbox" name="merge" checked> Kunla merges a PR when you approve its task</label>
        <div class="row"><button class="btn go">Connect with GitHub</button></div>
        <p class="muted" style="font-size:13.5px">GitHub opens and asks you to create the Kunla app, then to pick repositories. Two taps. It asks only to read pull requests, checks and code, plus write code if Kunla merges for you.</p></form>`;
  openSheet(html`<div class="sheet-body stack">
    <div><h2>Connect GitHub</h2><p class="muted">Pull requests and commits that mention a task key (like ${projects[0]?.key || 'MKT'}-12 in the title, branch, description or a commit message) then show up on the task without anyone logging them. An opened PR sends the task to Review with the PR attached; a merged PR finishes it, or waits for a person's review if the project asks for one.</p></div>
    ${raw(hookStatus(info))}
    ${raw(appBlock)}
    <form class="stack" style="gap:6px" data-act="submit:login"><div class="label">Your GitHub account</div>
      <p class="muted" style="font-size:13.5px">When a PR is merged from this account, Kunla counts it as your approval of the task, so you don't approve twice.</p>
      <div class="field"><label for="gh-login">GitHub username</label><input id="gh-login" name="login" autocomplete="off" placeholder="e.g. octocat" value="${me.github_login || ''}"></div><div class="row"><button class="btn">Save</button></div></form>
    <div class="row"><button class="btn quiet" data-act="click:close">Close</button></div></div>`, {
    login: async (f) => {
      const v = formData(f).login.trim();
      const r = await api('PATCH', `/api/members/${me.id}`, { github_login: v });
      me.github_login = r.github_login;
      toast(r.github_login ? `Saved. Merges from @${r.github_login} now count as your approval.` : 'Removed. Merges no longer count as your approval.');
    },
    connectApp: async (f) => {
      const d = f?.tagName === 'FORM' ? formData(f) : {};
      const r = await api('POST', '/api/integrations/github/app', { org: d.org || '', merge: f?.tagName === 'FORM' ? !!d.merge : undefined });
      if (r.install_url) { location.href = r.install_url; return; }
      // GitHub's manifest flow: a form POST to github.com carrying the app's description.
      const form = document.createElement('form');
      form.method = 'post'; form.action = r.action; form.style.display = 'none';
      const input = document.createElement('input'); input.type = 'hidden'; input.name = 'manifest'; input.value = r.manifest;
      form.append(input); document.body.append(form); form.submit();
    },
    recheck: () => showGitHub(),
  }, { focus: false });
}

// What GitHub has sent: the state in one sentence, each repository's latest delivery, and the last few.
function hookStatus(info) {
  const repos = info.repos || [], recent = info.recent || [];
  const ok = (st) => st < 300;
  // One big status a person can read at a glance: connected, wrong secret, waiting, or not set up.
  const names = repos.map((r) => r.repo);
  const installs = info.app?.installations || [];
  const [state, title, sub] = info.rejected
    ? ['bad', 'An old webhook is still sending', `${info.rejected.repo || 'A repository'} sent an event ${agoLong(info.rejected.created_at)} that the Kunla app didn't sign. Delete the old Kunla webhook in that repository's Settings → Webhooks; the app already delivers everything.`]
    : installs.length ? ['ok', 'Connected', info.last_delivery_at ? `Last heard from GitHub ${agoLong(info.last_delivery_at)}${names.length ? ` · ${names.length === 1 ? names[0] : `${names.length} repositories`}` : ''}` : `The Kunla app is installed on ${installs.map((i) => i.account).join(', ')}. Events show here as they arrive.`]
    : info.app?.registered ? ['wait', 'Almost there', 'The Kunla app exists. Tap Connect with GitHub and pick the repositories for this workspace.']
    : ['off', 'Not connected', 'Tap Connect with GitHub and pick the repositories.'];
  const line = html`<div class="hookstate ${state}" role="status"><span class="dot" aria-hidden="true"></span><div><div class="t">${title}</div><div class="s">${sub}</div></div></div>`;
  const repoList = repos.length ? html`<div class="stack" style="gap:6px"><div class="label">Repositories sending events</div><ul class="hooklog">${raw(repos.map((r) => html`<li><b>${r.repo}</b><span class="${ok(r.status) ? '' : 'bad'}">${r.result}</span><time>${agoLong(r.created_at)}</time></li>`).join(''))}</ul></div>` : '';
  const recentList = recent.length ? html`<details class="hookmore"><summary>Last ${recent.length} deliveries</summary><ul class="hooklog">${raw(recent.map((r) => html`<li><b>${r.event.replace('_', ' ')}</b>${r.repo ? html` <span class="muted">${r.repo}</span>` : ''}<span class="${ok(r.status) ? '' : 'bad'}">${r.result}</span><time>${agoLong(r.created_at)}</time></li>`).join(''))}</ul></details>` : '';
  const help = installs.length && info.app?.settings_url ? html`<details class="hookmore"><summary>Check it on GitHub</summary><ol class="steps"><li>Open the <a href="${info.app.settings_url}/advanced" target="_blank" rel="noopener">app's Advanced settings</a> on GitHub.</li><li>Under <b>Recent Deliveries</b>, a green tick means Kunla answered. A red mark shows Kunla's reply under <b>Response</b>.</li><li>Click <b>Redeliver</b>, then <b>Check again</b> here.</li></ol></details>` : '';
  return html`<div class="stack" style="gap:10px">${raw(line)}${raw(repoList)}${raw(recentList)}${raw(help)}${raw(installs.length ? '<div><button class="btn sm" type="button" data-act="click:recheck">Check again</button></div>' : '')}</div>`;
}

const PROJECT_NOTE = `Use the Kunla connector as this project's record of work.
- When a task key like MKT-42 comes up, call get_task and follow its brief, criteria, playbook and rules.
- All work counts, not only code. When we reach an outcome (a decision, a draft, research findings, notes on a paper, something I learned), call log_work yourself with one sentence, its kind, and the outcome in notes or links, then tell me the task key. Once per outcome, not every message.
- Put the task's citation line under the title of documents you write.
- If a decision belongs to a person, set the task blocked with the question instead of guessing.`;

function showClaudeAi() {
  const origin = location.origin;
  openSheet(html`<div class="sheet-body stack">
    <div><h2>Use Kunla in claude.ai</h2><p class="muted">One connector covers every chat and every Project on your claude.ai account, on web, desktop and phone. It joins ${me.workspace.name} as one agent, ${me.name}'s Claude, that you sponsor. Each workspace has its own address, so add one connector per workspace.</p></div>
    <ol class="steps">
      <li>In claude.ai, open <b>Settings → Connectors</b> and choose <b>Add custom connector</b>. Name it Kunla ${me.workspace.name} and paste this URL:</li>
    </ol>
    ${raw(copyBlock('Connector URL', mcpUrl()))}
    <ol class="steps" start="2">
      <li>Click <b>Connect</b>. A Kunla page opens; check the name and click <b>Allow</b>. If it asks for a token, paste your personal token for ${me.workspace.name}.</li>
      <li>In a chat, open the tools menu under the message box and switch Kunla on. Chats inside a Project use the same switch, so nothing extra is needed per Project.</li>
      <li>Optional, for a Project: paste this into the Project's instructions so Claude records its work there without being asked.</li>
    </ol>
    ${raw(copyBlock('Project instructions', PROJECT_NOTE))}
    <p class="muted" style="font-size:13.5px">Custom connectors need a paid claude.ai plan. On a Team or Enterprise plan an owner adds the connector once in the organization settings, then each person connects it. Removing the agent here signs out every chat at once.</p>
    <div class="row"><button class="btn quiet" data-act="click:close">Close</button></div></div>`);
}

// ---------- projects: the workspace, its projects, focus, playbooks, rules ----------
async function viewProjects() {
  renderShell('projects');
  const [rules, ws] = await Promise.all([api('GET', '/api/rules'), api('GET', `/api/projects/${me.workspace.key}`), loadKinds()]);
  // Kinds of work, one per line: built-ins by name ("Research"); your own as "Name: what to hand in".
  const kindLines = (list) => (list || []).map((d) => (d.builtin && !d.custom_hand_in ? d.label : `${d.label}: ${d.hand_in}`)).join('\n');
  const ownLines = (own) => (own || []).map((d) => {
    const b = kindsInfo?.defaults.find((x) => x.key === d.key);
    return b && d.hand_in === b.hand_in ? d.label : `${d.label}: ${d.hand_in}`;
  }).join('\n');
  const wsKinds = kindsInfo?.workspace;
  // The code repository, so "PR #12" or "acme/site!7" in a brief links to the right host (KD-42).
  const FORGE = { '': 'Code host: guess from the address', github: 'GitHub or GitHub Enterprise', gitlab: 'GitLab (gitlab.com or self-managed)', gitea: 'Gitea or Forgejo', bitbucket: 'Bitbucket' };
  const repoField = (id, x, help) => html`<div class="field"><label for="${id}">Code repository</label>
    <input id="${id}" name="repo_url" value="${x?.repo_url ?? ''}" placeholder="https://gitlab.acme.com/team/app or git@github.com:acme/site.git" autocomplete="off" spellcheck="false">
    <select name="repo_forge" aria-label="Code host" style="margin-top:6px">${join(Object.entries(FORGE).map(([k, l]) => html`<option value="${k}" ${(x?.repo_forge ?? '') === k ? 'selected' : ''}>${l}</option>`))}</select>
    <p class="muted hint-s">${help} Agents that work in a git repo fill this in from its remote when it is empty.</p></div>`;
  const kindsField = (id, own, inherited, from) => html`<div class="field kinds-field"><label for="${id}">Kinds of work</label>
    <p class="muted hint-s">One per line. Use a name from the list below to keep Kunla's guidance, or add your own as <code>Name: what to hand in</code>. ${from}</p>
    <textarea id="${id}" name="kinds" rows="5" placeholder="${kindLines(inherited)}">${ownLines(own)}</textarea>
    <p class="muted hint-s">Kunla's: ${(kindsInfo?.defaults || []).map((d) => d.label).join(', ')}.</p></div>`;
  const ruleRows = (rs) => rs.length ? rs.map((r) => html`<div class="rule-row"><input type="checkbox" class="switch" data-act="change:rule" data-id="${r.id}" ${r.active ? 'checked' : ''} aria-label="Rule on"><div class="grow"><div>${r.text}</div>
      <div class="m">${r.created_by}, ${agoLong(r.created_at)}${r.source_task ? ' · from ' + r.source_task : ''} · sent with ${plural(r.sent_with, 'task')}</div></div></div>`).join('')
    : '<p class="muted" style="font-size:14px">None yet. When you send work back, tick “Teach the team” and the correction lands here.</p>';
  const dateVal = (iso) => (iso ? iso.slice(0, 10) : '');
  // The weekly digest (KD-52): the Briefing, sent to a chat channel for people who don't open Kunla.
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const digestField = (d) => { d = d || { on: false, day: 1, format: 'slack', has_url: false }; return html`<div class="field digest-field"><div class="label" style="margin-bottom:6px">Weekly digest</div>
    <label class="check"><input type="checkbox" class="switch" name="digest_on" ${d.on ? 'checked' : ''}><span>Send a weekly digest to a chat channel</span></label>
    <p class="muted hint-s">For people who don't open Kunla: what finished per project, who worked on what, and what has waited too long. Sent early on the day you pick (UTC).</p>
    <div class="row" style="gap:8px;margin-top:6px">
      <select name="digest_day" aria-label="Day" style="width:auto">${join(DAYS.map((n, i) => html`<option value="${i}" ${d.day === i ? 'selected' : ''}>${n}</option>`))}</select>
      <select name="digest_format" aria-label="Kind of webhook" style="width:auto">${join([['slack', 'Slack (or anything taking {text})'], ['discord', 'Discord'], ['json', 'Plain JSON']].map(([k, l]) => html`<option value="${k}" ${d.format === k ? 'selected' : ''}>${l}</option>`))}</select></div>
    <input name="digest_url" type="url" style="margin-top:6px" placeholder="${d.has_url ? `Saved (${d.url_host}). Paste a new address to change it.` : 'https://hooks.slack.com/services/…'}" autocomplete="off" spellcheck="false">
    <div class="row" style="gap:8px;margin-top:6px"><button type="button" class="btn sm quiet" data-act="click:digestpreview">Preview</button>${raw(d.has_url && me.roles?.includes('admin') ? '<button type="button" class="btn sm quiet" data-act="click:digestsend">Send now</button>' : '')}</div>
    <pre class="digest-preview" id="digest-preview" hidden></pre></div>`; };
  // The workspace is the container and its projects are rows inside it (KD-17): one box, the
  // workspace as its header, so nobody reads the two as siblings. Settings fold away.
  const wsName = me.workspace.name;
  const wsRules = rules.filter((r) => r.project === me.workspace.key);
  $app.innerHTML = html`<div class="head"><div><h1>Projects</h1><p class="sub">Projects are optional; a task can live straight in the workspace. Focused projects are offered to agents first.</p></div>
      <button class="btn go" data-act="click:newp">New project</button></div>
    <form class="card pad stack hidden-form" data-act="submit:create" id="newp" hidden><h2 style="font-size:18px;font-weight:600">New project in ${wsName}</h2>
      <div class="row" style="align-items:flex-end">
        <div class="field" style="flex:2;min-width:180px"><label for="np-n">Name</label><input id="np-n" name="name" required placeholder="DACH launch"></div>
        <div class="field" style="flex:1;min-width:110px"><label for="np-k">Key</label><input id="np-k" name="key" required placeholder="DACH" maxlength="10" style="font-family:var(--mono);text-transform:uppercase"></div>
        <button class="btn go">Create</button></div></form>
    <section class="card wsbox">
      <form class="wsbox-head" data-act="submit:savews">
        <div class="wsbox-title"><span class="sp-dot"></span><input name="name" value="${wsName}" aria-label="Workspace name" class="title-in"><span class="pill mono">${me.workspace.key}</span></div>
        <div class="wsbox-meta muted">Workspace · ${plural(projects.length, 'project')} · <a href="#/tasks/${me.workspace.key}">tasks with no project</a></div>
        <details class="fold"><summary>Settings for everything in ${wsName}</summary>
          <div class="pb stack" style="margin-top:12px"><div class="field"><label for="pb-ws">Playbook for everything</label><textarea id="pb-ws" name="playbook" placeholder="How this workspace works: who we are, the voice, the tools.">${ws?.playbook ?? ''}</textarea></div>
            ${raw(repoField('repo-ws', ws, 'Used by projects that don’t name their own.'))}
            ${raw(kindsField('kd-ws', wsKinds?.own, kindsInfo?.defaults, 'Leave it empty to use Kunla’s kinds (shown faintly). Each project can set its own.'))}
            <div><div class="label" style="margin-bottom:6px">Rules for everyone</div>${raw(ruleRows(wsRules))}</div>
            ${raw(digestField(ws?.digest))}
            ${raw(me.roles?.includes('admin') ? html`<div class="field"><div class="label" style="margin-bottom:6px">Your data</div>
              <p class="muted" style="margin:0 0 6px;font-size:13px">One file with everything in ${wsName}: projects, tasks, history, reviews, rules, people, agents and their tokens. Another Kunla can import it, so the team can move without reconnecting anyone. Keep it safe like a password.</p>
              <div class="row"><button type="button" class="btn sm quiet" data-act="click:exportws">Download everything</button></div></div>` : '')}
            <div class="row"><button class="btn ink sm">Save</button></div></div></details>
      </form>
      <div class="wsbox-list">
      ${raw(projects.length ? '' : html`<p class="muted wsbox-empty">No projects yet. Tasks live straight in ${wsName} until you need one.</p>`)}
      ${join(projects.map((p, i) => { const rs = rules.filter((r) => r.project === p.key); return html`<form class="prow proj ${p.focus ? 'focused' : ''}" data-act="submit:save" data-key="${p.key}">
        <div class="prow-main">
          <span class="pill on mono">${p.key}</span>
          <input name="name" value="${p.name}" aria-label="Project name" class="title-in">
          <span class="prow-when muted">${p.ends_at ? endsIn(p.ends_at) : 'ongoing'}</span>
          <label class="prow-focus" title="Focused projects are offered to agents first"><input type="checkbox" class="switch" name="focus" ${p.focus ? 'checked' : ''}><span>Focus</span></label>
          <a class="btn quiet sm" href="#/tasks/${p.key}">Tasks</a>
          <button type="button" class="icon-btn" data-act="click:up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
        </div>
        <details class="fold"><summary>Settings${rs.length ? ` · ${plural(rs.length, 'rule')}` : ''}</summary>
          <div class="pb stack" style="margin-top:12px">
            <label class="row" style="gap:8px"><span class="label">Ends</span><input type="date" name="ends_at" value="${dateVal(p.ends_at)}" style="width:auto"><span class="muted" style="font-size:13px">empty = ongoing</span></label>
            <div class="field"><label for="pb-${p.key}">Playbook</label><textarea id="pb-${p.key}" name="playbook" placeholder="Voice, links, tools to use, things to avoid. Markdown.">${p.playbook}</textarea>
              <label class="check" style="margin-top:6px"><input type="checkbox" name="require_human_review" ${p.require_human_review ? 'checked' : ''}><span>Work must be approved by a person, not another agent</span></label></div>
            ${raw(repoField(`repo-${p.key}`, p, `Short mentions like PR #12 in ${p.key} briefs link here.${ws?.repo_url ? ' Empty uses the workspace’s.' : ''}`))}
            ${raw(kindsField(`kd-${p.key}`, kindsInfo?.projects.find((x) => x.key === p.key)?.own, wsKinds?.kinds, 'Leave it empty to use the workspace’s kinds (shown faintly).'))}
            <div><div class="label" style="margin-bottom:6px">Rules from reviews</div>${raw(ruleRows(rs))}</div>
            <div class="row"><button class="btn ink sm">Save</button></div></div></details>
      </form>`; }))}
      </div>
    </section>`;
  const refresh = async () => { [projects, me] = await Promise.all([api('GET', '/api/projects'), api('GET', '/api/me'), loadKinds()]); };
  const kindsValue = (text) => { const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean); return lines.length ? lines : null; };
  bind($app, {
    newp: () => { const f = $('newp'); f.hidden = !f.hidden; if (!f.hidden) f.querySelector('input').focus(); },
    save: async (f) => {
      const d = formData(f);
      await api('PATCH', `/api/projects/${f.dataset.key}`, { name: d.name, ...(d.playbook !== undefined ? { playbook: d.playbook } : {}), ...(d.kinds !== undefined ? { kinds: kindsValue(d.kinds) } : {}), require_human_review: !!d.require_human_review, focus: !!d.focus, ends_at: d.ends_at || null, ...(d.repo_url !== undefined ? { repo_url: d.repo_url.trim() || null, repo_forge: d.repo_forge || null } : {}) });
      await refresh(); toast('Saved. Agents get it with their next task.'); viewProjects();
    },
    savews: async (f) => {
      const d = formData(f);
      const digest = { on: !!d.digest_on, day: Number(d.digest_day ?? 1), format: d.digest_format || 'slack', ...((d.digest_url || '').trim() ? { url: d.digest_url.trim() } : {}) };
      await api('PATCH', `/api/projects/${me.workspace.key}`, { name: d.name, playbook: d.playbook, kinds: kindsValue(d.kinds), repo_url: (d.repo_url || '').trim() || null, repo_forge: d.repo_forge || null, digest });
      await refresh(); toast('Saved for the whole workspace.'); viewProjects();
    },
    digestpreview: async () => { const el = $('digest-preview'); const r = await api('GET', '/api/digest'); el.textContent = r.text; el.hidden = false; },
    exportws: async () => {
      const data = await api('GET', '/api/export');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
      a.download = `kunla-${data.workspace.key.toLowerCase()}-${data.exported_at.slice(0, 10)}.json`;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast(`Downloaded ${plural(data.tables.tasks.length, 'task')}.`);
    },
    digestsend: async () => { const r = await api('POST', '/api/digest/send'); toast(r.ok ? 'Digest sent.' : `Could not send it: ${r.error}`); },
    create: async (f) => { await api('POST', '/api/projects', formData(f)); await refresh(); viewProjects(); },
    rule: async (el) => { await api('PATCH', `/api/rules/${el.dataset.id}`, { active: el.checked }); toast(el.checked ? 'Rule on. Agents get it from now.' : 'Rule off.'); },
    up: async (el) => {
      const i = Number(el.dataset.i); const order = projects.map((p) => p.key);
      [order[i - 1], order[i]] = [order[i], order[i - 1]];
      await Promise.all(order.map((k, n) => api('PATCH', `/api/projects/${k}`, { rank: (n + 1) * 10 })));
      await refresh(); viewProjects();
    },
  });
  // Focus toggles save at once; it is the steering wheel, not a form field.
  $app.querySelectorAll('.proj input[name=focus]').forEach((el) => el.addEventListener('change', async () => {
    const key = el.closest('form').dataset.key;
    await api('PATCH', `/api/projects/${key}`, { focus: el.checked });
    await refresh(); toast(el.checked ? `${key} is in focus. next_task offers it first.` : `${key} is out of focus.`); viewProjects();
  }));
}

// ---------- ⌘K: delegate or jump ----------
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
function parseDelegation(text) {
  const [first = '', ...rest] = text.split('\n');
  let member = null; let project = null; let parent = null;
  const title = first.replace(/\^([A-Za-z][A-Za-z0-9]*-\d+)/g, (_, k) => { parent = k.toUpperCase(); return ''; }).replace(/@([\w'.-]+)/g, (_, w) => {
    const n = norm(w);
    member = members.find((m) => norm(m.name) === n) || members.find((m) => norm(m.name).startsWith(n)) || members.find((m) => norm(m.name).includes(n)) || member;
    return '';
  }).replace(/#([A-Za-z0-9]+)/g, (_, k) => { project = projects.find((p) => p.key === k.toUpperCase()) || project; return ''; }).replace(/\s+/g, ' ').trim();
  const criteria = rest.map((l) => l.replace(/^\s*(?:[-*•]|done when:?)\s*/i, '').trim()).filter(Boolean);
  return { title, member, project, criteria, parent };
}

let palTasks = [];
async function openPalette(prefill = '') {
  const box = $('palette');
  box.hidden = false;
  box.innerHTML = html`<div class="pal" role="dialog" aria-label="Delegate or jump">
    <textarea id="pal-in" rows="1" placeholder="Delegate a task, or jump to one…" aria-label="Delegate or jump"></textarea>
    <div class="hint">Delegate: <code>Webinar follow-up email @claude #MKT</code>, <code>^MKT-4</code> to make it a sub-task, then <kbd>⇧↵</kbd> for each “done when” line. No <code>#</code> means workspace-level. Jump: type a key or a few words.</div>
    <div class="chips" id="pal-chips"></div><div class="opts" id="pal-opts"></div></div>`;
  const input = $('pal-in');
  input.value = prefill;
  input.focus();
  let sel = 0; let opts = [];
  const pages = [['Briefing', '#/'], ['Work map', '#/map'], ['Tasks', '#/tasks'], ['Stuck tasks', '#/tasks', 'stuck'], ['Team', '#/team'], ['Projects', '#/projects'], ['Connect an agent', '#/team/connect'], ['Use Kunla in claude.ai', '#/team/claude-ai'], ['Connect GitHub', '#/team/github'],
    ...projects.map((p) => [`${p.name} tasks`, `#/tasks/${p.key}`]), ...savedViews().map((v) => [`View: ${v.name}`, v.hash, v])];
  const close = () => { box.hidden = true; box.innerHTML = ''; };
  const render = () => {
    const q = input.value;
    const d = parseDelegation(q);
    const ql = q.trim().toLowerCase();
    const where = d.parent ? `under ${d.parent}` : d.project ? `in ${d.project.key}` : `in ${me.workspace.name}, no project`;
    const chips = $('pal-chips');
    chips.innerHTML = d.title.split(' ').length >= 2 || d.member || d.project || d.parent
      ? html`<span class="pill ${d.member ? 'on' : ''}">For ${d.member ? d.member.name : 'anyone who picks it up'}</span><span class="pill ${d.project || d.parent ? 'on' : ''}">${where[0].toUpperCase() + where.slice(1)}</span>${raw(d.criteria.length ? html`<span class="pill on">${plural(d.criteria.length, 'check')}</span>` : '')}`
      : '';
    opts = [];
    if (d.title.length >= 4) opts.push({ kind: 'delegate', d: { ...d, where } });
    const tasks = ql ? palTasks.filter((t) => t.key.toLowerCase().includes(ql) || t.title.toLowerCase().includes(ql)).slice(0, 6)
      : palTasks.filter((t) => ['review', 'blocked', 'in_progress'].includes(t.status)).slice(0, 5);
    tasks.forEach((t) => opts.push({ kind: 'task', t }));
    pages.filter(([l]) => !ql || l.toLowerCase().includes(ql)).slice(0, ql ? 8 : 6).forEach(([l, h, v]) => opts.push({ kind: 'page', l, h, v }));
    if (sel >= opts.length) sel = 0;
    let g = '';
    $('pal-opts').innerHTML = opts.map((o, i) => {
      const grp = o.kind === 'delegate' ? 'Delegate' : o.kind === 'task' ? (ql ? 'Tasks' : 'Moving now') : 'Go to';
      const head = grp !== g ? `<div class="grp">${grp}</div>` : ''; g = grp;
      if (o.kind === 'delegate') return head + html`<div class="opt delegate ${i === sel ? 'on' : ''}" data-i="${i}"><span class="ic">+</span><div class="grow"><div class="t">${o.d.title}</div>
        <small>New task ${o.d.where} for ${o.d.member ? o.d.member.name : 'anyone'}${o.d.criteria.length ? ', done when: ' + o.d.criteria.join('; ') : ''}</small></div><kbd>↵</kbd></div>`;
      if (o.kind === 'task') return head + html`<div class="opt ${i === sel ? 'on' : ''}" data-i="${i}"><span class="ic">${o.t.key.split('-')[1]}</span><div class="grow"><div class="t">${o.t.title}</div><small>${o.t.key} · ${STATUS[o.t.status]}${o.t.assignee ? ' · ' + o.t.assignee.name : ''}</small></div></div>`;
      return head + html`<div class="opt ${i === sel ? 'on' : ''}" data-i="${i}"><span class="ic">→</span><div class="grow"><div class="t">${o.l}</div></div></div>`;
    }).join('');
    $('pal-opts').querySelectorAll('.opt').forEach((el) => { el.onclick = () => { sel = Number(el.dataset.i); run(); }; });
    input.style.height = 'auto'; input.style.height = Math.min(200, input.scrollHeight) + 'px';
  };
  const run = async () => {
    const o = opts[sel];
    if (!o) return;
    if (o.kind === 'page') {
      close();
      if (o.v && typeof o.v === 'object') Object.assign(tv, { mode: o.v.mode, group: o.v.group, filter: o.v.filter, q: o.v.q || '' });
      else if (o.v) Object.assign(tv, { filter: o.v, mode: 'list' });
      if (o.v) saveTv();
      if (location.hash === o.h) route(); else location.hash = o.h;
      return;
    }
    if (o.kind === 'task') { close(); location.hash = `#/t/${o.t.key}`; return; }
    try {
      const t = await api('POST', '/api/tasks', { ...(o.d.parent ? { parent: o.d.parent } : o.d.project ? { project: o.d.project.key } : {}), title: o.d.title, criteria: o.d.criteria, ...(o.d.member ? { assignee: o.d.member.name } : {}) });
      close();
      toast(o.d.member?.kind === 'ai' ? `${t.key} is with ${o.d.member.name}. It picks it up from next_task.` : `${t.key} is ready.`);
      location.hash = `#/t/${t.key}`;
    } catch (e) { toast(e.message); }
  };
  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(opts.length - 1, sel + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); }
  });
  box.onclick = (e) => { if (e.target === box) close(); };
  render();
  try { palTasks = await api('GET', '/api/tasks?limit=1000'); if (!members.length) members = await api('GET', '/api/members'); render(); } catch {}
}
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && me) { e.preventDefault(); $('palette').hidden ? openPalette() : ($('palette').hidden = true); return; }
  if (e.key === '/' && !typing() && me && $('palette').hidden) { e.preventDefault(); openPalette(); return; }
  keyHandler?.(e);
});

// ---------- router ----------
async function route() {
  clearInterval(pollTimer); pollTimer = null; pollCheck = null;
  keyHandler = null;
  // Arriving from another workspace with a token in the fragment: keep it, then drop it from the address bar.
  const use = (location.hash || '').match(/^#\/use\/([^/]+)(?:\/also\/(.+))?$/);
  if (use) {
    // Switching workspace: nothing open from the old one (the workspace menu, a sheet) may stay on screen.
    closePalette(); $('sheet').hidden = true;
    token = decodeURIComponent(use[1]); me = null;
    // Signing in with Google or Microsoft brings every workspace here with your email (KD-29): add them to the menu.
    if (use[2]) await Promise.all(use[2].split(',').map(decodeURIComponent).map(async (t) => {
      try {
        const r = await fetch('/api/me', { headers: { authorization: `Bearer ${t}` } });
        if (!r.ok) return;
        const m = await r.json();
        const entry = { url: location.origin, ws: m.workspace?.id, token: t, name: m.workspace?.name ?? location.host };
        saveSpaces([...loadSpaces().filter((x) => !sameSpace(x, entry)), entry]);
      } catch {}
    }));
    try { localStorage.setItem(TOKEN_KEY, token); } catch {}
    history.replaceState(null, '', location.pathname + '#/');
  }
  if (!token) return viewGate().catch((e) => toast(e.message));
  if (!me) {
    try {
      [me, projects, members] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/projects'), api('GET', '/api/members'), loadKinds()]);
    } catch { return; }
    $('gate').hidden = true;
    $('shell').hidden = false;
    window.kunlaInstall?.paint();
    rememberSpace();
  }
  const [, view = '', arg, arg2] = (location.hash || '#/').split('/');
  const render = {
    '': viewBriefing, map: () => (arg === 'relations' ? viewRelations(decodeURIComponent(arg2 || '')) : viewMap()), tasks: () => viewTasks(arg), team: () => viewTeam(arg), projects: viewProjects, playbook: viewProjects,
    t: () => viewTask(decodeURIComponent(arg || '')),
  }[view] || viewBriefing;
  if (!$app.innerHTML) $app.innerHTML = '<div class="skel"></div>';
  try { await render(); } catch (e) { toast(e.message); }
  window.scrollTo?.({ top: 0 });
  if (view !== '') api('GET', '/api/inbox').then((r) => { decisionCount = r.count; renderShell(view === 't' ? 'tasks' : view); }).catch(() => {});
  // Stay fresh cheaply: every 30 seconds, while the tab is visible, ask one tiny question
  // ("has anything changed?") and redraw only when the answer is yes. A hidden tab costs nothing.
  if (['', 'map', 'tasks', 't', 'team'].includes(view)) {
    let seen = null; let drawnAt = Date.now();
    const check = async () => {
      if (document.hidden || typing() || !$('palette').hidden) return;
      if ($('paused')) return;
      if (idle()) { showPaused(); return; }
      try {
        const { version } = await api('GET', '/api/changes');
        const stale = Date.now() - drawnAt > 10 * 60_000; // relative times ("5m ago") drift
        if (seen !== null && (version !== seen || stale)) { await render(); drawnAt = Date.now(); }
        seen = version;
      } catch {}
    };
    check(); pollCheck = check;
    pollTimer = setInterval(check, 30000);
  }
}
// Idle means no mouse, touch or keyboard for 3 minutes. An idle tab stops asking the server
// anything and shows a Refresh button; updates resume when that button is pressed.
const IDLE_MS = 3 * 60_000;
let lastActive = Date.now();
const idle = () => Date.now() - lastActive > IDLE_MS;
function showPaused() {
  let b = $('paused');
  if (b) return;
  b = document.createElement('button');
  b.id = 'paused'; b.className = 'paused';
  b.title = 'Live updates paused while you were away';
  b.innerHTML = '<span>Updates paused</span><b>Refresh</b>';
  b.onclick = () => { b.remove(); lastActive = Date.now(); route(); toast('Up to date.'); };
  document.body.appendChild(b);
}
for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']) document.addEventListener(ev, () => { lastActive = Date.now(); }, { passive: true });
document.addEventListener('visibilitychange', () => { if (document.hidden) return; if (idle()) showPaused(); else pollCheck?.(); });

window.addEventListener('hashchange', route);
route();
