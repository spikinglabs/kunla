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
const STATUS = { inbox: 'Proposed', ready: 'Ready', in_progress: 'In progress', blocked: 'Waiting on an answer', review: 'In review', done: 'Done', declined: 'Declined', parked: 'Later' };
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
      el.textContent = r.merge_by === 'agent' ? `Approving asks the agent to merge ${n} once its checks pass.`
        : r.error ? `Kunla couldn't read ${n}: ${r.error}`
        : r.state === 'merged' ? `${n} is already merged.`
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
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}
try { applyTheme(localStorage.getItem('kunla.theme')); } catch {}
$('theme').onclick = () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('kunla.theme', next); } catch {}
};

// ---------- sign in and first-run setup ----------
const WORD = '<span class="wordmark">kunla<i></i></span>';
async function viewGate() {
  $('shell').hidden = true;
  const gate = $('gate');
  gate.hidden = false;
  const s = await api('GET', '/api/setup');
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
      <div class="stack" style="gap:6px"><h1>Sign in</h1><p class="muted">Paste your personal token. Whoever added you to Kunla has it.</p></div>
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
  $('me').title = `${me.name}: workspaces and sign out`;
  $('space').innerHTML = html`<span class="sp-dot"></span><span class="sp-name">${me.workspace?.name ?? 'Workspace'}</span><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
}

// ---------- workspaces ----------
// A workspace is a hard boundary: its own people, agents and data, reached with its own token.
// Several can live in this Kunla, and others can be on other deployments. The browser keeps one
// token per workspace and asks each one directly; the server never links your memberships.
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
    <div class="opts" id="sp-list"><div class="opt on"><span class="ic">${initials(me.workspace?.name)}</span><div class="grow"><div class="t">${me.workspace?.name}</div><small>${me.workspace?.key} · this one · ${plural(decisionCount, 'decision')}</small></div></div></div>
    ${raw(me.roles?.includes('admin') ? html`<form class="pad stack" data-act="submit:create" style="border-top:1px solid var(--rule)"><div class="label">New workspace</div>
      <div class="row" style="flex-wrap:nowrap"><input name="name" required maxlength="80" placeholder="Community, My startup, Work…" aria-label="Workspace name"><input name="key" maxlength="10" placeholder="Key" aria-label="Task key prefix (optional)" style="max-width:84px;font-family:var(--mono);text-transform:uppercase"></div>
      <span class="muted" style="font-size:12px">Fully separate: nothing here is visible there. You join it as its admin; the key is picked for you if you leave it empty.</span>
      <div class="row"><button class="btn go sm">Create</button></div></form>` : '')}
    <details class="pad" style="border-top:1px solid var(--rule)"><summary class="label" style="cursor:pointer">Join a workspace on another Kunla</summary>
      <form class="stack" data-act="submit:add" style="margin-top:8px">
      <div class="row" style="flex-wrap:nowrap"><input name="url" required placeholder="https://kunla.other-org.com" aria-label="Kunla address"><input name="token" required type="password" placeholder="kun_…" aria-label="Your token there" style="max-width:180px"></div>
      <div class="row"><button class="btn sm">Join</button></div></form></details>
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
  const head = (label) => html`<div class="row" style="justify-content:space-between"><span class="eyebrow">${label} · ${t.key}${p ? ' · ' + p.name : ''}</span>
    ${raw(solo ? '' : html`<a class="btn quiet sm" href="#/t/${t.key}">Open</a>`)}</div>`;
  const title = solo ? '' : html`<h2><a href="#/t/${t.key}">${t.title}</a></h2>`;
  if (item.kind === 'review') {
    const round = t.review_rounds > 0 ? ` · round ${t.review_rounds + 1}` : '';
    return html`<form class="decision ${solo ? '' : 'card'}" data-key="${t.key}" data-act="submit:approve">
      ${raw(head(solo ? 'Waiting on your review' : 'Review'))}${raw(title)}
      <div class="byline">${raw(who(worker, t.deliverables?.some((d) => /^https:\/\/github\.com\//.test(d.url)) ? 'GitHub' : 'Someone'))}<span>sent this ${agoLong(t.updated_at)}${round}</span></div>
      ${raw(t.summary ? html`<p class="said">${t.summary}</p>` : '')}
      ${raw(t.deliverables?.length ? html`<div class="links">${join(t.deliverables.map((d) => html`<a class="pill" href="${d.url}" target="_blank" rel="noopener">${d.title || new URL(d.url).hostname} ↗</a>`))}</div>` : '')}
      ${raw(t.criteria?.length ? html`<div><div class="label" style="margin-bottom:6px">Tick what's met</div><div class="checks">${join(t.criteria.map((c, i) => html`<label class="check"><input type="checkbox" name="c${i}" data-crit="${c}"><span>${c}</span></label>`))}</div></div>` : '')}
      <div class="field"><label for="n-${t.key}">Note to ${callName(worker) || 'the worker'}</label>
        <textarea id="n-${t.key}" name="note" rows="2" placeholder="Optional when approving. Say what to fix when sending it back."></textarea></div>
      <div class="teach" data-teach>
        <label class="check"><input type="checkbox" name="teach" data-act="change:teach"><span><b>Teach the team.</b> <span class="hint">Turn this into a rule sent with every future ${p?.key ?? ''} task, to every agent.</span></span></label>
        <div hidden data-rule><input name="rule" aria-label="Rule" placeholder="e.g. Every pricing tier shows a price."></div>
      </div>
      ${raw(prNumber(t.deliverables) ? html`<p class="prstate" data-pr="${t.key}"></p>` : '')}
      <div class="acts">
        <button class="btn go" name="v" value="approved">${prNumber(t.deliverables) ? `Approve and merge PR #${prNumber(t.deliverables)}` : 'Approve'} <kbd>A</kbd></button>
        <button class="btn" type="button" data-act="click:changes">Send back <kbd>C</kbd></button>
        <span class="spacer"></span>
        <button class="btn quiet" type="button" data-act="click:later">Later <kbd>L</kbd></button>
      </div></form>`;
  }
  if (item.kind === 'question') {
    return html`<form class="decision ${solo ? '' : 'card'}" data-key="${t.key}" data-act="submit:answer">
      ${raw(head('Question'))}${raw(title)}
      <div class="byline">${raw(who(worker, 'An agent'))}<span>is stuck and asked ${agoLong(t.updated_at)}</span></div>
      <p class="ask">“${t.blocked_question}”</p>
      <div class="field"><label for="a-${t.key}">Your answer</label><textarea id="a-${t.key}" name="answer" rows="3" required placeholder="${callName(worker) || 'It'} continues as soon as you send this."></textarea></div>
      <div class="acts"><button class="btn go">Send answer <kbd>⌘↵</kbd></button><span class="spacer"></span>
        <button class="btn quiet" type="button" data-act="click:later">Later <kbd>L</kbd></button></div></form>`;
  }
  if (item.kind === 'proposal') {
    return html`<div class="decision ${solo ? '' : 'card'}" data-key="${t.key}">
      ${raw(head('Proposal'))}${raw(title)}
      <div class="byline">${raw(who(t.created_by, 'Someone'))}<span>suggested this ${agoLong(t.created_at)}</span></div>
      ${raw(t.brief ? html`<p class="said">${t.brief}</p>` : '')}
      <div class="acts"><button class="btn go" data-act="click:accept">Make it ready <kbd>A</kbd></button>
        <button class="btn" data-act="click:decline">Decline</button><span class="spacer"></span>
        <button class="btn quiet" type="button" data-act="click:later">Later <kbd>L</kbd></button></div></div>`;
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
    accept: async (el) => { const k = keyOf(el); await api('POST', `/api/tasks/${k}/triage`, { accept: true }); toast(`${k} is ready for anyone to pick up.`); await after(); },
    decline: async (el) => { const k = keyOf(el); await api('POST', `/api/tasks/${k}/triage`, { accept: false }); toast(`${k} declined.`); await after(); },
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
function headline(n, brief, pulse) {
  const h = new Date().getHours();
  const hi = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const first = firstName(me.name);
  if (!n) return html`${hi}, ${first}. <em>Nothing</em> needs you.`;
  return html`${hi}, ${first}. <em>${plural(n, 'decision')}</em> ${n === 1 ? 'needs' : 'need'} you.`;
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
  out.push(parts.length ? `Since yesterday ${parts.join('; ')}.` : 'Quiet since yesterday.');
  if (brief.rules_added) out.push(`You added ${plural(brief.rules_added, 'rule')}.`);
  if (brief.tidied) out.push(`Kunla closed ${plural(brief.tidied, 'stale proposal')}.`);
  const focus = projects.filter((p) => p.focus);
  if (focus.length) out.push(html`Focus: <b>${focus.map((p) => p.name).join(', ')}</b>.`);
  if (working) out.push(`${plural(working, 'agent')} ${working === 1 ? 'is' : 'are'} working now.`);
  if (blocked.length) out.push(html`<b>${blocked[0].name}</b> is waiting on an answer.`);
  return out.join(' ');
}

async function viewBriefing() {
  renderShell('');
  const [inbox, brief, pulse, rules, prog] = await Promise.all([
    api('GET', '/api/inbox'), api('GET', '/api/briefing?hours=24'), api('GET', '/api/pulse'), api('GET', '/api/rules'), api('GET', '/api/progress'),
  ]);
  // Projects first in focus order, then tasks with no project if there are any.
  const stats = [...prog.filter((x) => !x.workspace), ...prog.filter((x) => x.workspace && Object.keys(x.counts).length).map((x) => ({ ...x, name: 'No project' }))]
    .map((x) => ({ project: { key: x.key, name: x.name }, counts: x.counts }));
  decisionCount = inbox.count; renderShell('');
  const items = inbox.items;
  if (deck.i >= items.length) deck.i = 0;
  const cur = items[deck.i];
  const active = rules.filter((r) => r.active);
  const reach = active.reduce((s, r) => s + (r.sent_with || 0), 0);
  const order = { working: 0, blocked: 1, waiting: 2, idle: 3 };
  const people = [...pulse].sort((a, b) => order[a.state] - order[b.state]);

  $app.innerHTML = html`<section class="hello">
      <div class="eyebrow">${new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</div>
      <h1 style="margin-top:12px">${raw(headline(items.length, brief, pulse))}</h1>
      <p class="sub">${raw(subline(brief, pulse))}</p>
      <div class="row" id="elsewhere" style="margin-top:16px"></div>
    </section>
    <div class="brief">
      <section>
        ${raw(items.length ? html`<div class="deck-top"><span class="eyebrow">${deck.i + 1} of ${items.length}</span>
          <div class="dots">${join(items.map((it, i) => html`<button class="${i === deck.i ? 'on' : ''}" data-act="click:go" data-i="${i}" aria-label="Decision ${i + 1}: ${it.task.key}"></button>`))}</div></div>
          <div class="deck ${items.length > 1 ? 'more' : ''}">${raw(decisionCard(cur))}</div>`
        : html`<div class="card clear"><div class="big"><svg width="26" height="26" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
          <h2>All clear</h2><p class="muted">Nothing waits on you. Agents keep the record up to date on their own.</p>
          <button class="btn ink" data-act="click:palette">Delegate something <kbd>⌘K</kbd></button></div>`)}
        ${raw(brief.finished.length ? html`<div class="card pad" style="margin-top:28px"><div class="section-t"><h2>Finished since yesterday</h2><a class="muted" href="#/map" style="font-size:13px">See the map</a></div>
          <div class="done-list">${join(brief.finished.map((f) => html`<a href="#/t/${f.key}"><span class="key">${f.key}</span><span class="t grow">${f.title}</span><span class="muted" style="font-size:13px">${f.worker ?? ''}</span></a>`))}</div></div>` : '')}
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
  bind($app, {
    ...decisionHandlers(viewBriefing, () => { deck.i = (deck.i + 1) % items.length; viewBriefing(); }),
    go: (el) => { deck.i = Number(el.dataset.i); viewBriefing(); },
    palette: () => openPalette(),
  });
  keyHandler = (e) => {
    if (typing() || e.metaKey || e.ctrlKey || e.altKey || !$('palette').hidden || !$('sheet').hidden || !cur) return;
    const k = e.key.toLowerCase();
    const card = $app.querySelector('.decision');
    if (k === 'a') { e.preventDefault(); card.querySelector('.btn.go')?.click(); }
    else if (k === 'c' || k === 'r') { e.preventDefault(); card.querySelector('[data-act="click:changes"]')?.click(); }
    else if (k === 'l') { e.preventDefault(); card.querySelector('[data-act="click:later"]')?.click(); }
    else if (k === 'j') { e.preventDefault(); deck.i = (deck.i + 1) % items.length; viewBriefing(); }
    else if (k === 'k') { e.preventDefault(); deck.i = (deck.i - 1 + items.length) % items.length; viewBriefing(); }
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
  $app.innerHTML = html`<div class="head"><div><h1>Work map</h1>
      <p class="sub">Who worked on what, person or agent. Solid is work, dashed is work waiting on someone, lime is a decision. Nobody filled this in; it comes from the record.</p></div></div>
    <div class="map-tools"><div class="row map-ranges">${join(MAP_RANGES.map(([label, d]) => html`<button class="pill ${d === mapDays ? 'on' : ''}" data-act="click:days" data-n="${d}">${label}</button>`))}</div>
      <div class="zoom" role="group" aria-label="Zoom"><button class="btn sm" data-act="click:zoomOut" aria-label="Zoom out">−</button><span id="zoomv">${mapZoom}×</span><button class="btn sm" data-act="click:zoomIn" aria-label="Zoom in">+</button></div></div>
    <div class="card"><div class="map" id="map"></div></div>
    <div class="row map-key" style="margin:14px 4px 0"><span><i style="background:var(--ink)"></i>Working</span><span><i style="border:1.5px dashed var(--wait)"></i>Waiting on someone</span>
      <span><i style="background:var(--lime)"></i>A decision</span><span><i style="background:var(--sunk)"></i>Night</span><span class="muted">Pinch or use − / + to zoom. Tap a bar to open the task.</span></div>
    <div class="card pad" style="margin-top:28px"><div class="section-t"><h2>Where work waits now</h2><span class="muted" style="font-size:13px">Oldest first. Each one is a person, not an agent.</span></div>
      ${raw(m.waits.length ? html`<div class="waits">${join(m.waits.map((w) => { const ms = E - new Date(w.since).getTime(); return html`<a href="#/t/${w.key}"><span class="key">${w.key}</span>
        <span class="t">${w.title}<small>${w.who}: ${w.label.replace(w.key + ' ', '')}</small></span><span class="len"><i style="width:${(ms / longest) * 100}%"></i></span><span class="for">${span(ms)}</span></a>`; }))}</div>`
      : '<p class="muted">Nothing is waiting. Every task is either moving or done.</p>')}</div>`;
  const setZoom = (z) => { const keep = mapAnchor(); mapZoom = z; drawMap(keep); };
  bind($app, {
    days: (el) => { mapDays = Number(el.dataset.n); viewMap(); },
    zoomIn: () => setZoom(MAP_ZOOMS.find((z) => z > mapZoom) ?? mapZoom),
    zoomOut: () => setZoom([...MAP_ZOOMS].reverse().find((z) => z < mapZoom) ?? mapZoom),
  });
  drawMap();
  pinchZoom($('map'));
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
  const lanes = m.lanes.filter((l) => l.segments.length || members.find((mm) => mm.id === l.id)?.active);
  const seg = (s) => {
    const l = Math.max(0, x(s.start));
    const r = Math.min(nowX, x(s.end ?? m.end));
    const w = Math.max(0, r - l);
    const text = s.kind === 'decide' ? '' : s.kind === 'wait' ? s.label.replace(`${s.key} `, '') : s.title;
    return html`<a class="seg ${s.kind} ${s.live ? 'live' : ''}" href="#/t/${s.key}" style="left:${l}%;width:${w}%" title="${s.label} · ${when(s.start)}–${s.end ? clock(s.end) : 'now'}" aria-label="${s.label}"><span>${text}</span></a>`;
  };
  box.innerHTML = html`<div class="map-in" style="--label:${lw}px;width:${lw + tw}px">
    <div class="map-days"><div class="who"></div><div class="track">${join(ticks.map((d) => { const l = x(d.getTime()); return l >= 0 && l < 97 ? html`<span class="d ${d.getHours() === 0 ? 'day' : ''}" style="left:${l}%">${tickLabel(d)}</span>` : ''; }))}<i class="now" style="left:${nowX}%"></i></div></div>
    ${raw(lanes.length ? '' : '<p class="muted" style="padding:16px 0">No work recorded in this range. Try a longer one.</p>')}
    ${join(lanes.map((l) => html`<div class="lane"><div class="who">${raw(av(l, '', l.segments.some((s) => s.live)))}<span class="grow"><span class="name">${l.name}</span>
      <small>${l.kind === 'ai' ? PLATFORM[l.platform] || 'Agent' : 'Person'}</small></span></div>
      <div class="track">${raw(nights)}${raw(grid)}${join(l.segments.map(seg))}<i class="now bare" style="left:${nowX}%"></i></div></div>`))}
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

// ---------- task: review and teach ----------
const EVENT = {
  created: (e) => e.data?.status === 'inbox' ? 'proposed it' : 'wrote the brief', claimed: () => 'picked it up', work_logged: () => 'logged work',
  submitted: () => 'sent it for review', approved: () => 'approved it', changes_requested: () => 'sent it back', rule_added: () => 'taught the team a rule',
  blocked: () => 'asked a question', answered: () => 'answered', accepted: () => 'made it ready', declined: () => 'declined it',
  parked: (e) => (e.data?.until ? `put it off until ${new Date(e.data.until).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}` : 'put it off for someday'),
  unparked: () => 'brought it back',
  lease_expired: () => 'went quiet, so the claim lapsed', status: (e) => `moved it to ${STATUS[e.data?.to] || e.data?.to}`, flagged: () => 'flagged it', note: () => 'commented',
  merged: () => 'merged the PR', merge_waiting: () => 'will merge the PR when checks pass', merge_blocked: () => 'could not merge the PR yet',
  woke: () => 'woke the agent so it carries on', wake_failed: () => 'could not wake the agent',
  github: (e) => (e.data?.to && e.data.to !== e.data.from ? `moved it to ${STATUS[e.data.to] || e.data.to} from GitHub` : 'saw it on GitHub'),
};
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
    decision = decisionCard({ kind: 'review', task: { ...t, summary: sub?.note, deliverables: t.deliverables } }, { solo: true });
  } else if (t.status === 'blocked') decision = decisionCard({ kind: 'question', task: t }, { solo: true });
  else if (t.status === 'inbox') decision = decisionCard({ kind: 'proposal', task: t }, { solo: true });
  const mark = new Set(['submitted', 'approved', 'changes_requested', 'blocked', 'answered', 'rule_added']);
  const p = t.project ?? { key: t.workspace.key, name: t.workspace.name };
  const subs = t.subtasks;
  const subDone = subs.filter((x) => ['done', 'declined'].includes(x.status)).length;
  $app.innerHTML = html`<div class="task"><article>
      <div class="crumbs"><a href="#/tasks">${t.workspace.name}</a>${raw(t.project ? html`<span>/</span><a href="#/tasks/${p.key}">${p.name}</a>` : '')}
        ${raw(t.parent ? html`<span>/</span><a href="#/t/${t.parent.key}">${t.parent.key} ${t.parent.title}</a>` : '')}<span>/</span><span class="mono">${t.key}</span></div>
      <h1>${t.title}</h1>
      <div class="row"><span class="pill ${t.status === 'review' ? 'lime' : t.status === 'blocked' ? 'warn' : t.status === 'done' ? 'on' : ''}">${STATUS[t.status]}</span>
        <div class="people"><span>${raw(who(t.assignee, 'Nobody yet'))}</span>${raw(t.reviewer ? html`<span class="muted">reviewed by</span><span>${raw(who(t.reviewer))}</span>` : '')}
        ${raw(t.created_by ? html`<span class="muted">asked by ${t.created_by.name}</span>` : '')}</div></div>
      ${raw(decision ? html`<div class="card" style="margin-top:24px">${raw(decision)}</div>` : '')}
      ${raw(t.status === 'parked' ? html`<div class="card pad parked-note"><div class="grow"><b>Put off ${t.snoozed_until ? 'until ' + new Date(t.snoozed_until).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }) : 'for someday'}.</b>
        <span class="muted">It is out of the briefing and agents leave it alone. When it comes back it returns to ${STATUS[t.returns_to] || 'Ready'}.</span></div><button class="btn go" data-act="click:unpark">Bring it back</button></div>`
        : !decision && OPEN.has(t.status) ? '<div class="row" style="margin-top:12px"><button class="btn quiet sm" data-act="click:later">Later…</button></div>' : '')}
      ${raw(t.brief ? html`<div class="sec"><h3>Brief</h3><p class="prose">${t.brief}</p></div>` : '')}
      ${raw(!t.parent ? html`<div class="sec"><h3>Sub-tasks${subs.length ? ` · ${subDone} of ${subs.length} done` : ''}</h3>
        ${raw(subs.length ? html`<div class="bar" style="margin:0 0 12px">${raw(subs.length ? `<span class="b-done" style="width:${(subDone / subs.length) * 100}%"></span>` : '')}</div>
          <div class="subs">${join(subs.map((x) => html`<a href="#/t/${x.key}" class="subrow ${['done', 'declined'].includes(x.status) ? 'fin' : ''}"><span class="key">${x.key}</span><span class="t grow">${x.title}</span><span class="muted" style="font-size:13px">${x.assignee ?? ''}</span><span class="pill">${STATUS[x.status]}</span></a>`))}</div>` : '')}
        <form class="row" data-act="submit:addsub" style="margin-top:10px;flex-wrap:nowrap"><input name="title" placeholder="${subs.length ? 'Add another sub-task' : 'Split this into sub-tasks: type one and press Enter'}" aria-label="New sub-task"><button class="btn sm">Add</button></form>
        ${raw(subs.length ? '<p class="muted" style="font-size:13px;margin-top:8px">When every sub-task is finished, this task finishes on its own.</p>' : '')}</div>` : '')}
      ${raw(t.criteria.length && !(t.status === 'review' && decision) ? html`<div class="sec"><h3>Done when</h3><ul class="crit ${t.status === 'done' ? 'met' : ''}">${join(t.criteria.map((c) => html`<li>${c}</li>`))}</ul></div>` : '')}
      ${raw(t.deliverables.length && !(t.status === 'review' && decision) ? html`<div class="sec"><h3>The work</h3><div class="links">${join(t.deliverables.map((d) => html`<a class="pill" href="${d.url}" target="_blank" rel="noopener">${d.title || d.url} ↗</a>`))}</div></div>` : '')}
      ${raw(t.sessions?.length ? html`<div class="sec"><h3>Worked on in</h3><div class="links">${join(t.sessions.map((x) => x.url
        ? html`<a class="pill" href="${x.url}" target="_blank" rel="noopener" title="${x.member ? x.member + ', ' : ''}${agoLong(x.created_at)}">${sessionLabel(x.url)}${x.member ? ' · ' + x.member : ''} ↗</a>`
        : html`<span class="pill" title="${x.member ? x.member + ', ' : ''}${agoLong(x.created_at)}"><code>${x.ref}</code></span>`))}</div></div>` : '')}
      <div class="sec"><h3>How it got here</h3><div class="trail">${join(hist.map((e) => html`<div class="ev ${mark.has(e.type) ? 'mark' : ''} ${e.type === 'rule_added' ? 'rule' : ''}">
        <span class="when">${when(e.created_at)}</span>${raw(e.actor ? av({ name: e.actor, kind: e.actor_kind }, 'sm') : '<span class="av sm">K</span>')}
        <div><div class="what">${e.actor ?? 'Kunla'} ${(EVENT[e.type] || (() => e.type))(e)}</div>${raw(e.note && e.type !== 'created' ? html`<div class="note">${e.note}</div>` : '')}</div></div>`))}</div></div>
      <div class="sec"><h3>Comment</h3><form class="composer" data-act="submit:comment">
        <textarea name="text" rows="3" placeholder="${t.assignee?.kind === 'ai' ? `${t.assignee.name} reads this the next time it opens ${t.key}.` : 'Add a note to the record.'}"></textarea>
        <div class="acts"><button class="btn ink">Comment</button></div>
      </form></div>
    </article>
    <aside class="aside">
      <div class="brain"><h3>Sent with this task</h3>
        ${raw(t.rules.length ? html`<ol class="rules-mini" style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:8px;font-size:14px">${join(t.rules.map((r) => html`<li>${r.text}${raw(r.project === t.workspace.key ? ' <span class="m-ws">everywhere</span>' : '')}</li>`))}</ol>` : '<p class="s" style="color:#b9b6ac;font-size:13.5px">No rules yet.</p>')}
        ${raw(t.playbook ? html`<details class="playbook"><summary>Playbook</summary><pre>${t.playbook}</pre></details>` : '')}</div>
      <div class="card pad"><h3>Cite it anywhere</h3><div class="cite">${join([['Commit trailer', t.references.commit_trailer], ['Branch', t.references.branch], ['Doc source line', t.references.doc_source_line], ['Link', t.references.link]].map(([l, v]) => html`<button type="button" data-act="click:copy" data-v="${v}"><small>${l}</small><code>${v}</code></button>`))}</div></div>
    </aside></div>`;
  const reload = () => viewTask(key);
  const text = () => $app.querySelector('.composer textarea').value.trim();
  bind($app, {
    ...decisionHandlers(reload),
    later: () => showLater(t.key, reload),
    unpark: async () => { const r = await api('POST', `/api/tasks/${t.key}/unpark`); toast(`${t.key} is back in ${STATUS[r.status]}.`); reload(); },
    addsub: async (f) => {
      const title = formData(f).title.trim(); if (!title) return;
      const n = await api('POST', '/api/tasks', { parent: t.key, title });
      toast(`${n.key} added under ${t.key}.`); reload();
    },
    comment: async (f) => { if (!text()) throw new Error('Write something first.'); await api('POST', `/api/tasks/${t.key}/comment`, { text: text() }); toast('Added to the record.'); reload(); },
    copy: async (el) => { try { await navigator.clipboard.writeText(el.dataset.v); toast('Copied.'); } catch { toast(el.dataset.v); } },
  });
  $app.querySelectorAll('textarea[name=answer]').forEach((ta) => ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ta.form.requestSubmit(); }));
}

// ---------- tasks: one list that stays useful at hundreds of tasks ----------
// You manage views, not lists: pick a filter and a grouping, save it, and come back to it.
const VIEWS_KEY = 'kunla.views';
const tv = { mode: 'list', group: 'project', filter: 'open', q: '' };
try { Object.assign(tv, JSON.parse(localStorage.getItem('kunla.tv') || '{}')); } catch {}
const saveTv = () => { try { localStorage.setItem('kunla.tv', JSON.stringify({ mode: tv.mode, group: tv.group, filter: tv.filter })); } catch {} };
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
const GROUPS = { project: 'Project', person: 'Person', status: 'Status' };
const STATUS_ORDER = ['blocked', 'review', 'in_progress', 'ready', 'inbox', 'parked', 'done', 'declined'];

async function viewTasks(project) {
  renderShell('tasks');
  const all = await api('GET', `/api/tasks?limit=1000${project ? '&project=' + project : ''}`);
  const p = projects.find((x) => x.key === project) || (project === me.workspace.key ? { key: project, name: 'No project' } : null);
  const draw = () => {
    const ql = tv.q.trim().toLowerCase();
    const pass = (t) => FILTERS[tv.filter][1](t) && (!ql || t.key.toLowerCase().includes(ql) || t.title.toLowerCase().includes(ql) || (t.assignee?.name ?? '').toLowerCase().includes(ql));
    const shown = all.filter(pass);
    const keys = new Set(shown.map((t) => t.key));
    const counts = Object.fromEntries(Object.keys(FILTERS).map((k) => [k, all.filter(FILTERS[k][1]).length]));
    const views = savedViews();
    const head = html`<div class="head"><div><h1>${p ? p.name : 'Tasks'}</h1><p class="sub">${p ? '' : 'Every task in the workspace. '}Agents move these themselves; you choose what to look at.</p></div>
        <button class="btn go" data-act="click:new">New task <kbd>⌘K</kbd></button></div>
      <div class="toolbar">
        <div class="row">${join(Object.entries(FILTERS).map(([k, [label]]) => html`<button class="pill ${tv.filter === k ? 'on' : ''}" data-act="click:filter" data-k="${k}">${label} <span class="mono" style="opacity:.6">${counts[k]}</span></button>`))}</div>
        <div class="row" style="margin-left:auto">
          <input class="search" placeholder="Filter by words, key or person" value="${tv.q}" data-act="input:q" aria-label="Filter">
          ${raw(tv.mode === 'list' ? html`<select data-act="change:group" aria-label="Group by">${join(Object.entries(GROUPS).map(([k, l]) => html`<option value="${k}" ${tv.group === k ? 'selected' : ''}>Group by ${l.toLowerCase()}</option>`))}</select>` : '')}
          <div class="seg-toggle"><button class="${tv.mode === 'list' ? 'on' : ''}" data-act="click:mode" data-m="list">List</button><button class="${tv.mode === 'board' ? 'on' : ''}" data-act="click:mode" data-m="board">Board</button></div>
        </div></div>
      <div class="row" style="margin:-4px 0 18px">${raw(!project ? '' : html`<a class="pill" href="#/tasks">← All tasks</a>`)}
        ${join(views.map((v, i) => html`<span class="pill saved"><a href="${v.hash}" data-act="click:view" data-i="${i}">${v.name}</a><button data-act="click:unsave" data-i="${i}" aria-label="Forget ${v.name}">×</button></span>`))}
        <button class="pill" data-act="click:save" style="border-style:dashed">+ Save this view</button></div>`;
    let body;
    if (tv.mode === 'board') {
      const cols = [['inbox', 'Proposed'], ['ready', 'Ready'], ['in_progress', 'In progress'], ['blocked', 'Waiting'], ['review', 'In review'], ['done', 'Done']];
      body = html`<div class="cols">${join(cols.map(([s, label]) => { const list = shown.filter((t) => t.status === s); return html`<section class="col"><h3><span>${label}</span><span>${list.length}</span></h3>
        <div class="list">${raw(list.length ? list.slice(0, 60).map(tcard).join('') + (list.length > 60 ? `<div class="empty-col">${list.length - 60} more. Narrow the filter.</div>` : '') : '<div class="empty-col">None</div>')}</div></section>`; }))}</div>`;
    } else {
      // Top-level rows are tasks whose parent is not shown; sub-tasks nest under their parent.
      const tops = shown.filter((t) => !t.parent || !keys.has(t.parent));
      const kids = (k) => shown.filter((t) => t.parent === k);
      const groupOf = (t) => tv.group === 'project' ? (t.project ?? '') : tv.group === 'person' ? (t.assignee?.name ?? '') : t.status;
      const order = tv.group === 'project' ? [...projects.map((x) => x.key), ''] : tv.group === 'status' ? STATUS_ORDER : null;
      const gkeys = [...new Set(tops.map(groupOf))].sort((a, b) => order ? order.indexOf(a) - order.indexOf(b) : (a || '~').localeCompare(b || '~'));
      const label = (g) => {
        if (tv.group === 'project') { const pr = projects.find((x) => x.key === g); return pr ? html`${raw(pr.focus ? '<span class="focus-dot"></span>' : '')}${pr.name} <span class="key">${pr.key}</span>${raw(pr.ends_at ? ` <span class="muted" style="font-weight:400;font-size:13px">${esc(endsIn(pr.ends_at))}</span>` : '')}` : 'No project'; }
        if (tv.group === 'person') return g || 'Nobody yet';
        return STATUS[g];
      };
      body = gkeys.length ? join(gkeys.map((g) => { const rows = tops.filter((t) => groupOf(t) === g); return html`<section class="card group"><h2>${raw(label(g))} <span class="muted mono" style="font-size:12px;font-weight:400">${rows.length}</span></h2>
        <div class="rows">${join(rows.slice(0, 200).map((t) => trow(t) + kids(t.key).map((k) => trow(k, true)).join('')))}${raw(rows.length > 200 ? `<p class="muted pad">${rows.length - 200} more. Narrow the filter.</p>` : '')}</div></section>`; }))
        : raw(`<div class="card clear"><h2>Nothing here</h2><p class="muted">${tv.filter === 'stuck' ? 'Nothing is stuck. Good.' : 'Try another filter.'}</p></div>`);
    }
    $app.innerHTML = head + `<div class="tlist">${body.__raw ?? body}</div>`;
    bind($app, {
      new: () => openPalette(p && project !== me.workspace.key ? `#${p.key} ` : ''),
      filter: (el) => { tv.filter = el.dataset.k; saveTv(); draw(); },
      mode: (el) => { tv.mode = el.dataset.m; saveTv(); draw(); },
      group: (el) => { tv.group = el.value; saveTv(); draw(); },
      q: (el) => { tv.q = el.value; clearTimeout(draw.t); draw.t = setTimeout(() => { draw(); const i = $app.querySelector('.search'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 180); },
      save: () => {
        const name = prompt('Name this view', `${FILTERS[tv.filter][0]}${p ? ' · ' + p.name : ''}${tv.q ? ' · ' + tv.q : ''}`);
        if (!name) return;
        const list = savedViews(); list.push({ name, hash: location.hash || '#/tasks', mode: tv.mode, group: tv.group, filter: tv.filter, q: tv.q });
        try { localStorage.setItem(VIEWS_KEY, JSON.stringify(list)); } catch {}
        toast(`Saved “${name}”.`); draw();
      },
      view: (el) => { const v = savedViews()[Number(el.dataset.i)]; Object.assign(tv, { mode: v.mode, group: v.group, filter: v.filter, q: v.q || '' }); saveTv(); if (location.hash === v.hash) draw(); else location.hash = v.hash; },
      unsave: (el) => { const list = savedViews(); list.splice(Number(el.dataset.i), 1); try { localStorage.setItem(VIEWS_KEY, JSON.stringify(list)); } catch {} draw(); },
    });
  };
  draw();
}
function tcard(t) {
  return html`<a class="card tcard" href="#/t/${t.key}"><span class="key">${t.key}${t.parent ? ' · under ' + t.parent : ''}</span><span class="t">${t.title}</span>
    <span class="f">${raw(who(t.assignee, t.status === 'ready' ? 'Anyone' : '—'))}<span class="key">${t.subtasks ? `${t.subtasks.done}/${t.subtasks.total} · ` : ''}${ago(t.updated_at)}</span></span></a>`;
}
function trow(t, child = false) {
  return html`<a class="trow ${child ? 'child' : ''}" href="#/t/${t.key}"><span class="st-dot s-${t.status}" title="${STATUS[t.status]}"></span><span class="key">${t.key}</span>
    <span class="t">${t.title}${raw(t.subtasks ? ` <span class="subcount">${t.subtasks.done}/${t.subtasks.total}</span>` : '')}</span>
    <span class="stx">${STATUS[t.status]}</span><span class="w">${raw(who(t.assignee, t.status === 'ready' ? 'Anyone' : ''))}</span><span class="key">${ago(t.updated_at)}</span></a>`;
}

// ---------- team ----------
const canManage = (m) => me.kind === 'human' && (me.roles?.includes('admin') || m.sponsor_id === me.id || m.id === me.id);

async function viewTeam(sub) {
  renderShell('team');
  const [record, pulse] = await Promise.all([api('GET', '/api/members'), api('GET', '/api/pulse')]);
  members = record;
  const ps = new Map(pulse.map((p) => [p.id, p]));
  $app.innerHTML = html`<div class="head"><div><h1>Team</h1><p class="sub">People and agents side by side. Each agent works under its own name, with a person who sponsors it. Lanes keep each one on the projects you choose.</p></div>
      <div class="row"><button class="btn go" data-act="click:connect">Connect an agent</button><button class="btn" data-act="click:claudeai">Use in claude.ai</button><button class="btn" data-act="click:addPerson">Add a person</button>${raw(me.roles?.includes('admin') ? '<button class="btn" data-act="click:github">Connect GitHub</button>' : '')}</div></div>
    <div class="people-grid">${join(record.map((m) => { const p = ps.get(m.id) || {}; return html`<div class="card pad member">
      <div class="row" style="flex-wrap:nowrap">${raw(av(m, 'lg', p.live))}<div class="grow"><div class="nm">${m.name}</div><div class="muted" style="font-size:13px">${kindLine(m)}</div></div><span class="state ${p.state || 'idle'}">${p.state || 'idle'}</span></div>
      <div style="font-size:14px;color:var(--ink-2);min-height:21px">${raw(p.task ? html`<a href="#/t/${p.task.key}">${p.line}</a>` : esc(m.last_active ? `Last active ${agoLong(m.last_active)}` : 'Not active yet'))}</div>
      <div class="stats"><div><b>${m.done}</b><small>done</small></div><div><b>${m.first_pass_rate == null ? '–' : m.first_pass_rate + '%'}</b><small>first try</small></div><div><b>${m.active}</b><small>active</small></div></div>
      ${raw(projects.length ? html`<div><div class="label" style="margin-bottom:6px">Works on</div><div class="row lanepick" data-id="${m.id}">
        <button class="pill ${m.scope.length ? '' : 'on'}" data-act="click:lane" data-k="">Everything</button>${join(projects.map((x) => html`<button class="pill ${m.scope.includes(x.key) ? 'on' : ''}" data-act="click:lane" data-k="${x.key}">${x.key}</button>`))}</div></div>` : '')}
      ${raw(canManage(m) ? html`<div><button class="btn sm" data-act="click:manage" data-id="${m.id}">Manage</button></div>` : '')}</div>`; }))}</div>`;
  bind($app, {
    connect: () => showConnect('ai'), addPerson: () => showConnect('human'), claudeai: showClaudeAi, github: showGitHub,
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
  // Open a linked dialog once, then drop it from the URL so a background refresh doesn't reopen it.
  if (sub && $('sheet').hidden) { if (sub === 'connect') showConnect('ai'); if (sub === 'claude-ai') showClaudeAi(); if (sub === 'github') showGitHub(); }
  if (sub) history.replaceState(null, '', '#/team');
}

// Dialogs live outside the page, so the 30-second refresh never wipes them. A "sticky" one
// (a token shown once) closes only from its own button, not by tapping outside or Escape.
let sheetSticky = false;
function openSheet(inner, handlers = {}, { sticky = false } = {}) {
  const s = $('sheet');
  sheetSticky = sticky;
  s.innerHTML = `<div class="pal sheet-card" role="dialog" aria-modal="true">${inner}</div>`;
  s.hidden = false;
  bind(s, {
    close: () => closeSheet(true),
    copy: async (el) => { try { await navigator.clipboard.writeText(el.dataset.v); el.textContent = 'Copied'; setTimeout(() => { el.textContent = 'Copy'; }, 1600); } catch { toast('Copy did not work here. Select the text and copy it.'); } },
    ...handlers,
  });
  s.querySelector('input:not([type=hidden]):not([type=date])')?.focus();
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
      <div class="row"><button class="btn go">Add</button><button class="btn quiet" type="button" data-act="click:close">Cancel</button></div></form></div>`;
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
    : copyBlock('MCP server', `URL     ${mcpUrl()}\nHeader  Authorization: Bearer ${r.token}`);
  openSheet(html`<div class="sheet-body stack"><div>${raw(head)}</div>${raw(copyBlock('Token', r.token, { secret: true }))}${raw(setup)}
    <div class="row"><button class="btn ink" data-act="click:close">I've saved it</button></div></div>`, {}, { sticky: true });
}

function showManage(m) {
  const self = m.id === me.id;
  openSheet(html`<div class="sheet-body stack">
    <div><h2>${m.name}</h2><p class="muted">${kindLine(m)}</p></div>
    <form class="stack" data-act="submit:rename"><div class="field"><label for="mm-n">Name</label><input id="mm-n" name="name" required value="${m.name}" maxlength="80"></div>
      <div><button class="btn">Save name</button></div></form>
    <div class="stack" style="gap:6px"><div class="label">Token</div>
      <p class="muted" style="font-size:13.5px">${self ? 'Get a new personal token. Your old one stops working everywhere, and this browser switches to the new one.' : 'Get a new token if the old one leaked or you set it up somewhere else. Every old token for this agent stops working at once.'}</p>
      <div><button class="btn" data-act="click:rotate">New token</button></div></div>
    ${raw(m.kind === 'ai' ? html`<form class="stack" style="gap:6px" data-act="submit:wake"><div class="label">Wake it up</div>
      <p class="muted" style="font-size:13.5px">When you approve, send back, answer or hand ${m.name} a task, Kunla calls this URL so it carries on by itself. For Claude Code, use your repository's dispatch URL and a GitHub token, with the workflow from the README.</p>
      <div class="field"><label for="mw-u">Wake-up URL</label><input id="mw-u" name="url" type="url" placeholder="https://api.github.com/repos/OWNER/REPO/dispatches" value="${m.wake?.url || ''}"></div>
      <div class="field"><label for="mw-a">Token for that URL (optional)</label><input id="mw-a" name="auth" type="password" autocomplete="off" placeholder="${m.wake?.has_auth ? 'Saved. Leave empty to keep it.' : 'GitHub token, or empty'}"></div>
      <div class="row"><button class="btn">${m.wake ? 'Save' : 'Turn on'}</button>${raw(m.wake ? '<button class="btn" type="button" data-act="click:wakeTest">Send a test</button><button class="btn quiet" type="button" data-act="click:wakeOff">Turn off</button>' : '')}</div></form>` : '')}
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
    wakeTest: async () => {
      const r = await api('POST', `/api/members/${m.id}/wake/test`);
      toast(r.ok ? `Test call delivered (HTTP ${r.status}).` : `Test call failed: ${r.error}.`);
    },
    wakeOff: async () => { await api('DELETE', `/api/members/${m.id}/wake`); m.wake = null; toast(`${m.name} no longer gets wake-up calls.`); closeSheet(true); viewTeam(); },
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

// GitHub: one webhook per repository. PRs and commits that cite a task key then update the task by themselves.
async function showGitHub(secret) {
  const g = typeof secret === 'string' ? null : await api('GET', '/api/integrations/github');
  const info = g || showGitHub.last;
  showGitHub.last = info;
  const fresh = typeof secret === 'string';
  openSheet(html`<div class="sheet-body stack">
    <div><h2>Connect GitHub</h2><p class="muted">Pull requests and commits that mention a task key (like ${projects[0]?.key || 'MKT'}-12 in the title, branch, description or a commit message) then show up on the task without anyone logging them. An opened PR sends the task to Review with the PR attached; a merged PR finishes it, or waits for a person's review if the project asks for one.</p></div>
    <p class="muted" style="font-size:13.5px">${info.last_delivery_at ? `Last heard from GitHub ${agoLong(info.last_delivery_at)}.` : info.secret_set ? 'Set up, but nothing has arrived from GitHub yet.' : 'Not connected yet.'}</p>
    ${raw(fresh ? '' : html`<div><button class="btn go" data-act="click:make">${info.secret_set ? 'Make a new secret' : 'Make the secret'}</button></div>
      ${raw(info.secret_set ? '<p class="muted" style="font-size:13.5px">A new secret replaces the old one at once; paste it into every repository that uses the old one.</p>' : '')}`)}
    ${raw(fresh ? html`<ol class="steps"><li>In the GitHub repository, open <b>Settings → Webhooks → Add webhook</b>.</li><li>Paste these values. Kunla shows the secret only once.</li></ol>
      ${raw(copyBlock('Payload URL', info.webhook_url))}${raw(copyBlock('Secret', secret, { secret: true }))}
      <ol class="steps" start="3"><li>Content type: <b>application/json</b>. Events: choose <b>Let me select individual events</b>, then tick <b>Pull requests</b>, <b>Pushes</b> and <b>Check suites</b>.</li><li>Click <b>Add webhook</b>. GitHub sends a ping, and this page shows when it arrived.</li></ol>` : '')}
    ${raw(fresh ? '' : html`<form class="stack" style="gap:6px" data-act="submit:token"><div class="label">Merge on approve</div>
      <p class="muted" style="font-size:13.5px">${info.merge_token_set ? 'Kunla merges a task\'s PR when you approve it (squash, once checks pass).' : 'Without a token, approving asks the agent to merge. With one, Kunla merges the PR itself. Use a fine-grained token with Pull requests and Contents: Read and write.'}</p>
      <div class="field"><label for="gh-t">GitHub token</label><input id="gh-t" name="token" type="password" autocomplete="off" placeholder="${info.merge_token_set ? 'Saved. Paste a new one to replace it.' : 'github_pat_...'}"></div>
      <div class="row"><button class="btn">Save token</button>${raw(info.merge_token_set ? '<button class="btn quiet" type="button" data-act="click:untoken">Remove</button>' : '')}</div></form>`)}
    <div class="row"><button class="btn quiet" data-act="click:close">${fresh ? "I've saved it" : 'Close'}</button></div></div>`, {
    token: async (f) => { const v = formData(f).token; if (!v) return toast('Paste a token first.'); await api('PUT', '/api/integrations/github/token', { token: v }); toast('Saved. Approving now merges PRs.'); showGitHub(); },
    untoken: async () => { await api('PUT', '/api/integrations/github/token', { token: null }); toast('Removed. Approving now asks the agent to merge.'); showGitHub(); },
    make: async () => { const r = await api('POST', '/api/integrations/github'); showGitHub.last = r; showGitHub(r.secret); },
  }, { sticky: fresh });
}

const PROJECT_NOTE = `Use the Kunla connector as this project's record of work.
- When a task key like MKT-42 comes up, call get_task and follow its brief, criteria, playbook and rules.
- When you finish something for the team (a draft, analysis or plan), call log_work with one sentence and links, and tell me the task key.
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
  const [rules, ws] = await Promise.all([api('GET', '/api/rules'), api('GET', `/api/projects/${me.workspace.key}`)]);
  const ruleRows = (rs) => rs.length ? rs.map((r) => html`<div class="rule-row"><input type="checkbox" class="switch" data-act="change:rule" data-id="${r.id}" ${r.active ? 'checked' : ''} aria-label="Rule on"><div class="grow"><div>${r.text}</div>
      <div class="m">${r.created_by}, ${agoLong(r.created_at)}${r.source_task ? ' · from ' + r.source_task : ''} · sent with ${plural(r.sent_with, 'task')}</div></div></div>`).join('')
    : '<p class="muted" style="font-size:14px">None yet. When you send work back, tick “Teach the team” and the correction lands here.</p>';
  const dateVal = (iso) => (iso ? iso.slice(0, 10) : '');
  $app.innerHTML = html`<div class="head"><div><h1>Projects</h1><p class="sub">Projects are optional. A task can live straight in the workspace. Focused projects are offered to agents first; a project can be ongoing or end on a date.</p></div>
      <button class="btn go" data-act="click:newp">New project</button></div>
    <form class="card pad stack hidden-form" data-act="submit:create" id="newp" hidden><h2 style="font-size:18px;font-weight:600">New project</h2>
      <div class="row" style="align-items:flex-end">
        <div class="field" style="flex:2;min-width:180px"><label for="np-n">Name</label><input id="np-n" name="name" required placeholder="DACH launch"></div>
        <div class="field" style="flex:1;min-width:110px"><label for="np-k">Key</label><input id="np-k" name="key" required placeholder="DACH" maxlength="10" style="font-family:var(--mono);text-transform:uppercase"></div>
        <button class="btn go">Create</button></div></form>
    <div class="stack" style="gap:16px;margin-top:8px">
    ${join(projects.map((p, i) => { const rs = rules.filter((r) => r.project === p.key); return html`<form class="card pad stack proj ${p.focus ? 'focused' : ''}" data-act="submit:save" data-key="${p.key}">
      <div class="row" style="flex-wrap:nowrap"><span class="pill on mono">${p.key}</span><input name="name" value="${p.name}" aria-label="Project name" class="title-in">
        <button type="button" class="icon-btn" data-act="click:up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button></div>
      <div class="row">
        <label class="check focus-check"><input type="checkbox" class="switch" name="focus" ${p.focus ? 'checked' : ''}><span><b>Focus</b> <span class="muted">offered first to everyone</span></span></label>
        <label class="row" style="gap:8px;margin-left:auto"><span class="label">Ends</span><input type="date" name="ends_at" value="${dateVal(p.ends_at)}" style="width:auto"><span class="muted" style="font-size:13px">${p.ends_at ? endsIn(p.ends_at) : 'ongoing'}</span></label>
      </div>
      <details><summary class="label" style="cursor:pointer">Playbook, review setting and ${plural(rs.length, 'rule')}</summary>
      <div class="pb" style="margin-top:12px"><div class="field"><label for="pb-${p.key}">Playbook</label><textarea id="pb-${p.key}" name="playbook" placeholder="Voice, links, tools to use, things to avoid. Markdown.">${p.playbook}</textarea>
          <label class="check" style="margin-top:6px"><input type="checkbox" name="require_human_review" ${p.require_human_review ? 'checked' : ''}><span>Work must be approved by a person, not another agent</span></label></div>
        <div><div class="label" style="margin-bottom:6px">Rules from reviews</div>${raw(ruleRows(rs))}</div></div></details>
      <div class="row"><button class="btn ink sm">Save</button><a class="btn quiet sm" href="#/tasks/${p.key}">Open tasks</a></div></form>`; }))}
    <form class="card pad stack ws" data-act="submit:savews"><div class="row"><span class="eyebrow">Workspace</span><span class="pill mono">${me.workspace.key}</span></div>
      <input name="name" value="${me.workspace.name}" aria-label="Workspace name" class="title-in">
      <p class="muted" style="font-size:14px">The top of the hierarchy. Tasks with no project live here, and this playbook and these rules go with every task in every project.</p>
      <div class="pb"><div class="field"><label for="pb-ws">Playbook for everything</label><textarea id="pb-ws" name="playbook" placeholder="How this workspace works: who we are, the voice, the tools.">${ws?.playbook ?? ''}</textarea></div>
        <div><div class="label" style="margin-bottom:6px">Rules for everyone</div>${raw(ruleRows(rules.filter((r) => r.project === me.workspace.key)))}</div></div>
      <div class="row"><button class="btn ink sm">Save</button><a class="btn quiet sm" href="#/tasks/${me.workspace.key}">Tasks with no project</a></div></form></div>`;
  const refresh = async () => { [projects, me] = await Promise.all([api('GET', '/api/projects'), api('GET', '/api/me')]); };
  bind($app, {
    newp: () => { const f = $('newp'); f.hidden = !f.hidden; if (!f.hidden) f.querySelector('input').focus(); },
    save: async (f) => {
      const d = formData(f);
      await api('PATCH', `/api/projects/${f.dataset.key}`, { name: d.name, ...(d.playbook !== undefined ? { playbook: d.playbook } : {}), require_human_review: !!d.require_human_review, focus: !!d.focus, ends_at: d.ends_at || null });
      await refresh(); toast('Saved. Agents get it with their next task.'); viewProjects();
    },
    savews: async (f) => { const d = formData(f); await api('PATCH', `/api/projects/${me.workspace.key}`, { name: d.name, playbook: d.playbook }); await refresh(); renderShell('projects'); toast('Saved for the whole workspace.'); },
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
  const use = (location.hash || '').match(/^#\/use\/(.+)$/);
  if (use) {
    // Switching workspace: nothing open from the old one (the workspace menu, a sheet) may stay on screen.
    closePalette(); $('sheet').hidden = true;
    token = decodeURIComponent(use[1]); me = null;
    try { localStorage.setItem(TOKEN_KEY, token); } catch {}
    history.replaceState(null, '', location.pathname + '#/');
  }
  if (!token) return viewGate().catch((e) => toast(e.message));
  if (!me) {
    try {
      [me, projects, members] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/projects'), api('GET', '/api/members')]);
    } catch { return; }
    $('gate').hidden = true;
    $('shell').hidden = false;
    rememberSpace();
  }
  const [, view = '', arg] = (location.hash || '#/').split('/');
  const render = {
    '': viewBriefing, map: viewMap, tasks: () => viewTasks(arg), team: () => viewTeam(arg), projects: viewProjects, playbook: viewProjects,
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
  b.innerHTML = '<span>Paused while you were away</span><b>Refresh</b>';
  b.onclick = () => { b.remove(); lastActive = Date.now(); route(); toast('Up to date.'); };
  document.body.appendChild(b);
}
for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']) document.addEventListener(ev, () => { lastActive = Date.now(); }, { passive: true });
document.addEventListener('visibilitychange', () => { if (document.hidden) return; if (idle()) showPaused(); else pollCheck?.(); });

window.addEventListener('hashchange', route);
route();
