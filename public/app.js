// Kunla web app: static, no build step. Talks to the same API the agents use.
const $ = (id) => document.getElementById(id);
const $app = $('app');
const TOKEN_KEY = 'kunla.token';
let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch {}
let me = null;
let projects = [];
let pollTimer = null;
let keyHandler = null;

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const html = (strings, ...vals) => strings.reduce((out, s, i) => out + s + (i < vals.length ? (vals[i]?.__raw ?? esc(vals[i])) : ''), '');
const raw = (s) => ({ __raw: s ?? '' });
const join = (arr) => raw(arr.join(''));

function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
const agoLong = (iso) => { const a = ago(iso); return a === 'now' ? 'just now' : `${a} ago`; };
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayLabel = (iso) => {
  const d = new Date(iso), t = new Date();
  const y = new Date(t); y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
};
const initials = (name) => (name || '?').replace(/'s\b/g, '').split(/[\s.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const av = (m, cls = '') => m ? html`<span class="av ${m.kind === 'ai' ? 'ai' : ''} ${cls}" title="${m.name}${m.kind === 'ai' ? ' (AI)' : ''}">${initials(m.name)}</span>` : '';
const who = (m, fallback = 'Unassigned') => m ? html`<span class="who">${raw(av(m))}<span class="name">${m.name}</span></span>` : html`<span class="muted">${fallback}</span>`;

const STATUS = { inbox: 'Proposed', ready: 'Ready', in_progress: 'In progress', blocked: 'Blocked', review: 'In review', done: 'Done', declined: 'Declined' };
const GLYPH = {
  inbox: '<circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.2 2"/>',
  ready: '<circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  in_progress: '<circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="currentColor"/>',
  blocked: '<circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4.5 7h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  review: '<circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="7" cy="7" r="2.2" fill="currentColor"/>',
  done: '<circle cx="7" cy="7" r="6.25" fill="currentColor"/><path d="M4.4 7.2l1.8 1.8 3.5-3.7" fill="none" stroke="var(--surface)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  declined: '<circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5 5l4 4M9 5l-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
};
const st = (s) => `<span class="st ${s}" title="${STATUS[s]}"><svg viewBox="0 0 14 14" aria-hidden="true">${GLYPH[s]}</svg></span>`;

const VERB = {
  created: 'created', claimed: 'picked up', work_logged: 'logged work on', submitted: 'submitted', approved: 'approved',
  changes_requested: 'asked for changes on', rule_added: 'added a rule from', blocked: 'asked a question on', answered: 'answered',
  accepted: 'accepted', declined: 'declined', lease_expired: 'released', status: 'moved', flagged: 'flagged', note: 'updated',
};

const ICON = {
  inbox: '<svg viewBox="0 0 16 16"><path d="M2 9.5l1.6-5.2A1 1 0 0 1 4.6 3.5h6.8a1 1 0 0 1 1 .8L14 9.5V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z M2 9.5h3.5l1 1.5h3l1-1.5H14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  board: '<svg viewBox="0 0 16 16"><path d="M2.5 3h3v10h-3zM6.5 3h3v6h-3zM10.5 3h3v8h-3z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  status: '<svg viewBox="0 0 16 16"><path d="M2.5 13.5h11M4 11V8M7 11V5M10 11V7M13 11V3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  team: '<svg viewBox="0 0 16 16"><circle cx="6" cy="6" r="2.5" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="10" y="4" width="4" height="4" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M1.8 13c.6-2.2 2.3-3.3 4.2-3.3S9.6 10.8 10.2 13M10.5 13c.3-1.6 1.2-2.6 2.5-2.9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  settings: '<svg viewBox="0 0 16 16"><path d="M3 3.5h10M3 8h10M3 12.5h6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
};
const MARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="var(--ink)"/><path d="M8 6v12M8 12l7-6M10.4 10l5.6 8" stroke="var(--paper)" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>';

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
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
        if (ev === 'submit' || el.tagName === 'A' || el.tagName === 'BUTTON') e.preventDefault();
        try { await handlers[name](el, e); } catch (err) { toast(err.message); }
      });
    }
  });
}
const formData = (form) => Object.fromEntries(new FormData(form).entries());
const typing = () => document.activeElement?.matches('input, textarea, select');

// ---------- sign in and first-run setup ----------
async function viewGate() {
  $('shell').hidden = true;
  const gate = $('gate');
  gate.hidden = false;
  const s = await api('GET', '/api/setup');
  gate.innerHTML = !s.set_up ? html`<div class="gate-card">
      <div class="wordmark">${raw(MARK)}<span>Kunla</span></div>
      <div class="stack" style="gap:6px"><h1>Set up your workspace</h1>
      <p>You'll be its first member and admin. Agents join later from the Team page.</p></div>
      <form class="stack" data-act="submit:setup">
        <div class="field"><label for="g-name">Your name</label><input id="g-name" name="name" required autocomplete="name"></div>
        <div class="field"><label for="g-pname">First project</label><input id="g-pname" name="project_name" required placeholder="Q1 campaign"></div>
        <div class="field"><label for="g-pkey">Task key prefix</label><input id="g-pkey" name="project_key" required placeholder="MKT" maxlength="10" style="font-family:var(--mono);text-transform:uppercase">
          <span class="muted" style="font-size:12px">Tasks in this project will be numbered MKT-1, MKT-2, and so on.</span></div>
        ${raw(s.needs_setup_token ? html`<div class="field"><label for="g-st">Setup token</label><input id="g-st" name="setup_token" required type="password"></div>` : '')}
        <button class="primary" style="justify-content:center">Create workspace</button>
      </form></div>`
    : html`<div class="gate-card">
      <div class="wordmark">${raw(MARK)}<span>Kunla</span></div>
      <div class="stack" style="gap:6px"><h1>Sign in</h1><p>Paste your personal token. An admin can create one for you on the Team page.</p></div>
      <form class="stack" data-act="submit:signin">
        <div class="field"><label for="g-token">Token</label><input id="g-token" name="token" required placeholder="kun_…" type="password" autocomplete="current-password"></div>
        <button class="primary" style="justify-content:center">Sign in</button>
      </form></div>`;
  bind(gate, {
    setup: async (f) => {
      const r = await api('POST', '/api/setup', formData(f));
      token = r.token; try { localStorage.setItem(TOKEN_KEY, token); } catch {}
      gate.innerHTML = html`<div class="gate-card"><div class="wordmark">${raw(MARK)}<span>Kunla</span></div>
        <div class="stack" style="gap:6px"><h1>Save your token</h1><p>It signs you in on other devices. It is shown once, so put it in your password manager now.</p></div>
        <div class="secret">${token}</div>
        <button class="primary" data-act="click:go" style="justify-content:center">Continue to connect an agent</button></div>`;
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
function renderSide(view, count) {
  const nav = [['inbox', 'Inbox'], ['board', 'Board'], ['status', 'Progress'], ['team', 'Team'], ['settings', 'Projects']];
  $('side').innerHTML = html`
    <div class="wordmark">${raw(MARK)}<span>Kunla</span></div>
    <nav class="nav" aria-label="Main">${join(nav.map(([k, label]) => html`<a href="#/${k}" class="${k === view ? 'on' : ''}">${raw(ICON[k])}<span class="label">${label}</span>
      ${raw(k === 'inbox' && count ? `<span class="count">${count}</span>` : '')}</a>`))}</nav>
    <div class="projects"><div class="side-label">Projects</div>
      ${join(projects.map((p) => html`<a href="#/board/${p.key}"><span class="key">${p.key}</span><span>${p.name}</span></a>`))}</div>
    <div class="side-foot"><button class="ghost me-btn" data-act="click:signout" title="Sign out ${me.name}">${raw(av({ name: me.name, kind: 'human' }))}</button><span class="name">${me.name}</span>
      <button class="ghost so" data-act="click:signout">Sign out</button></div>`;
  bind($('side'), { signout: signOut });
}
let inboxCount = 0;
const refreshCount = () => api('GET', '/api/inbox').then((d) => { inboxCount = d.count; const c = document.querySelector('.nav .count'); if (c) c.textContent = d.count || ''; if (c) c.hidden = !d.count; }).catch(() => {});

// ---------- inbox: the home screen ----------
const KIND = { review: 'Review', question: 'Question', proposal: 'Proposal', flagged: 'Stuck' };
let inboxSel = null;

async function viewInbox(selKey) {
  const data = await api('GET', '/api/inbox');
  inboxCount = data.count;
  renderSide('inbox', data.count);
  const items = data.items;
  if (selKey) inboxSel = selKey;
  if (!items.find((i) => i.task.key === inboxSel)) inboxSel = window.innerWidth > 760 ? items[0]?.task.key ?? null : null;
  const sel = items.find((i) => i.task.key === inboxSel);
  const wait = (i) => i.kind === 'review' ? i.task.assignee : i.kind === 'question' ? i.task.assignee : i.task.created_by;

  $app.innerHTML = html`<div class="inbox ${selKey ? 'has-sel' : ''}">
    <section class="queue" aria-label="Waiting on you">
      <div class="queue-head"><h1>Inbox</h1><span class="muted num">${items.length ? `${items.length} waiting on you` : ''}</span></div>
      ${join(items.map((i) => html`<a class="qitem ${i.task.key === inboxSel ? 'on' : ''}" href="#/inbox/${i.task.key}" data-key="${i.task.key}">
        <span class="chip ${i.kind}">${KIND[i.kind]}</span><span class="key">${i.task.key}</span><span class="key num">${ago(i.task.updated_at)}</span>
        <span class="title">${i.task.title}</span>
        <span class="meta">${raw(who(wait(i)))}</span></a>`))}
      ${raw(items.length ? '' : '<div class="empty"><strong>Nothing is waiting on you</strong><span>Reviews, questions from agents and new proposals show up here.</span></div>')}
      <div class="queue-foot"><span><kbd>j</kbd> <kbd>k</kbd> move</span><span><kbd>a</kbd> approve</span><span><kbd>r</kbd> request changes</span></div>
    </section>
    <section class="detail" aria-label="Selected item">${raw(sel ? inboxDetail(sel) : (items.length ? '' : ''))}</section>
  </div>`;
  const refresh = () => viewInbox(selKey);
  bind($app, decisionHandlers(refresh, items));
  keyHandler = (e) => {
    if (typing() || e.metaKey || e.ctrlKey || e.altKey) return;
    const idx = items.findIndex((i) => i.task.key === inboxSel);
    if (e.key === 'j' || e.key === 'k') {
      const next = items[Math.max(0, Math.min(items.length - 1, idx + (e.key === 'j' ? 1 : -1)))];
      if (next) { inboxSel = next.task.key; viewInbox(selKey ? next.task.key : undefined); }
    } else if (e.key === 'a' && sel?.kind === 'review') { $app.querySelector('[data-act="click:approve"]')?.click(); }
    else if (e.key === 'r' && sel?.kind === 'review') { e.preventDefault(); $app.querySelector('[data-act="click:openChanges"]')?.click(); }
  };
}

function deliverables(ds) {
  if (!ds?.length) return '<p class="warn">No link to the work was attached.</p>';
  return `<div class="links">${ds.map((d) => {
    let host = '';
    try { host = new URL(d.url).hostname.replace(/^www\./, ''); } catch {}
    return /^https?:\/\//i.test(d.url)
      ? html`<a href="${d.url}" target="_blank" rel="noopener"><span>${d.title || d.url}</span><span class="key">${host}</span></a>`
      : html`<span>${d.url}</span>`;
  }).join('')}</div>`;
}

function inboxDetail({ kind, task: t }) {
  const back = html`<a href="#/inbox" class="back-to-queue muted">← Inbox</a>`;
  const head = html`${raw(back)}<div class="stack" style="gap:8px">
    <div class="byline"><span class="chip ${kind}">${KIND[kind]}</span><a class="key" href="#/t/${t.key}">${t.key}</a></div>
    <h2>${t.title}</h2></div>`;
  let body = '';
  if (kind === 'review') {
    body = html`<div class="byline">${raw(who(t.assignee))}<span>submitted ${agoLong(t.updated_at)}</span>
        ${raw(t.review_rounds ? html`<span class="warn">Round ${t.review_rounds + 1}</span>` : '')}</div>
      ${raw(t.summary ? html`<div><div class="section-label">Their summary</div><p class="quote">${t.summary}</p></div>` : '')}
      <div><div class="section-label">The work</div>${raw(deliverables(t.deliverables))}</div>
      ${raw(t.criteria.length ? html`<div><div class="section-label">Check against</div><ul class="criteria">${join(t.criteria.map((c) => html`<li>${c}</li>`))}</ul></div>` : '')}
      ${raw(t.brief ? html`<details><summary class="section-label" style="cursor:pointer;display:list-item">Brief</summary><p class="prose">${t.brief}</p></details>` : '')}
      ${raw(reviewControls(t.key))}`;
  } else if (kind === 'question') {
    body = html`<div class="byline">${raw(who(t.assignee))}<span>is waiting for an answer</span></div>
      <p class="quote" style="font-size:16px">${t.blocked_question}</p>
      <form class="decide" data-act="submit:answer" data-key="${t.key}">
        <div class="field"><label for="ans-${t.key}">Your answer goes back to ${t.assignee?.name || 'the task'}</label>
        <textarea id="ans-${t.key}" name="answer" required style="min-height:70px"></textarea></div>
        <div class="row"><button class="primary">Send answer</button></div></form>`;
  } else if (kind === 'proposal') {
    body = html`<div class="byline">${raw(who(t.created_by))}<span>proposed this ${agoLong(t.created_at)}</span></div>
      ${raw(t.brief ? html`<p class="prose">${t.brief}</p>` : '<p class="muted">No details given.</p>')}
      <div class="decide"><div class="row">
        <button class="primary" data-act="click:triage" data-key="${t.key}" data-accept="1">Add to Ready</button>
        <button data-act="click:triage" data-key="${t.key}" data-accept="0">Decline</button></div></div>`;
  } else {
    body = html`<p class="prose">This task has been sent back ${t.review_rounds} times. The brief may be unclear, or a person should take it over.</p>
      <div class="row"><a class="btn" href="#/t/${t.key}">Open the task</a></div>`;
  }
  return `<div class="detail-inner">${head}${body}</div>`;
}

function reviewControls(key) {
  const project = key.split('-')[0];
  return html`<div class="decide">
    <div class="row"><button class="primary" data-act="click:approve" data-key="${key}">Approve <kbd>a</kbd></button>
      <button data-act="click:openChanges">Request changes <kbd>r</kbd></button></div>
    <form class="composer" data-act="submit:changes" data-key="${key}" hidden>
      <div class="field"><label for="ww-${key}">What needs to change</label><textarea id="ww-${key}" name="what_was_wrong" required></textarea></div>
      <div class="rule-box"><label class="check"><input type="checkbox" name="make_rule" data-act="change:toggleRule"> Make this a rule for every ${project} task</label>
        <input name="rule" hidden placeholder="Write it as an instruction, e.g. Show every price in EUR and USD.">
        <span class="muted" style="font-size:12px">Agents get the project's rules with each new task, so you don't have to correct this again.</span></div>
      <div class="row"><button class="primary">Send back</button><button type="button" class="ghost" data-act="click:closeChanges">Cancel</button></div>
    </form></div>`;
}

function decisionHandlers(refresh) {
  return {
    approve: async (el) => { await api('POST', `/api/tasks/${el.dataset.key}/review`, { verdict: 'approved' }); toast(`Approved ${el.dataset.key}`); refresh(); refreshCount(); },
    openChanges: (el) => { const f = el.closest('.decide').querySelector('.composer'); f.hidden = false; f.querySelector('textarea').focus(); },
    closeChanges: (el) => { el.closest('.composer').hidden = true; },
    toggleRule: (el) => {
      const r = el.closest('form').querySelector('[name=rule]');
      r.hidden = !el.checked;
      if (el.checked) { if (!r.value) r.value = el.closest('form').querySelector('textarea').value; r.focus(); }
    },
    changes: async (f) => {
      const d = formData(f);
      await api('POST', `/api/tasks/${f.dataset.key}/review`, { verdict: 'changes_requested', what_was_wrong: d.what_was_wrong, rule: d.make_rule ? d.rule : undefined });
      toast(d.make_rule && d.rule ? `Sent back. The rule applies to future ${f.dataset.key.split('-')[0]} tasks.` : `Sent ${f.dataset.key} back`);
      refresh(); refreshCount();
    },
    answer: async (f) => { await api('POST', `/api/tasks/${f.dataset.key}/answer`, formData(f)); toast('Answer sent'); refresh(); refreshCount(); },
    triage: async (el) => {
      await api('POST', `/api/tasks/${el.dataset.key}/triage`, { accept: el.dataset.accept === '1' });
      toast(el.dataset.accept === '1' ? `${el.dataset.key} is ready to pick up` : `Declined ${el.dataset.key}`); refresh(); refreshCount();
    },
  };
}

// ---------- board ----------
async function viewBoard(project) {
  renderSide('board', inboxCount);
  const tasks = await api('GET', `/api/tasks?limit=300${project ? `&project=${project}` : ''}`);
  const p = projects.find((x) => x.key === project);
  const cols = ['ready', 'in_progress', 'blocked', 'review', 'done'];
  const proposals = tasks.filter((t) => t.status === 'inbox').length;
  $app.innerHTML = html`<div class="page" style="max-width:none">
    <div class="page-head"><div><h1>${p ? p.name : 'All work'}</h1>
      <p class="sub">${proposals ? `${proposals} proposal${proposals > 1 ? 's' : ''} waiting in your inbox` : 'Everything open across projects'}</p></div>
      <div class="tools"><select aria-label="Project" data-act="change:project"><option value="">All projects</option>
        ${join(projects.map((x) => html`<option value="${x.key}" ${x.key === project ? 'selected' : ''}>${x.name}</option>`))}</select>
        <button class="primary" data-act="click:newTask">New task</button></div></div>
    <div class="board">${join(cols.map((s) => {
      const list = tasks.filter((t) => t.status === s).slice(0, s === 'done' ? 15 : 300);
      return html`<div class="col"><div class="col-head">${raw(st(s))}${STATUS[s]} <span class="num">${list.length}</span></div>
        ${join(list.map((t) => html`<a class="tile" href="#/t/${t.key}">
          <span class="t">${t.title}</span>
          <span class="foot"><span class="key">${t.key}</span>${raw(t.assignee ? who(t.assignee) : '')}</span></a>`))}</div>`;
    }))}</div></div>
    ${raw(newTaskDialog(project))}`;
  bind($app, {
    project: (el) => { location.hash = el.value ? `#/board/${el.value}` : '#/board'; },
    newTask: () => $app.querySelector('dialog').showModal(),
    closeDialog: () => $app.querySelector('dialog').close(),
    createTask: async (f) => {
      const d = formData(f);
      const t = await api('POST', '/api/tasks', {
        project: d.project, title: d.title, brief: d.brief,
        criteria: d.criteria.split('\n').map((s) => s.trim()).filter(Boolean), assignee: d.assignee || undefined,
      });
      location.hash = `#/t/${t.key}`;
    },
  });
}

function newTaskDialog(project) {
  return html`<dialog><form class="stack" data-act="submit:createTask">
    <div><h2>New task</h2><p class="muted">Write it so an agent could start without asking you anything.</p></div>
    <div class="field"><label for="nt-p">Project</label><select id="nt-p" name="project">${join(projects.map((p) => html`<option value="${p.key}" ${p.key === project ? 'selected' : ''}>${p.name} (${p.key})</option>`))}</select></div>
    <div class="field"><label for="nt-t">Title</label><input id="nt-t" name="title" required></div>
    <div class="field"><label for="nt-b">Brief</label><textarea id="nt-b" name="brief" placeholder="The goal, who it's for, links to anything they need"></textarea></div>
    <div class="field"><label for="nt-c">Done when (one per line)</label><textarea id="nt-c" name="criteria" style="min-height:64px"></textarea></div>
    <div class="field"><label for="nt-a">Assign to</label><input id="nt-a" name="assignee" placeholder="Leave empty so anyone can pick it up"></div>
    <div class="row"><button class="primary">Create task</button><button type="button" class="ghost" data-act="click:closeDialog">Cancel</button></div>
  </form></dialog>`;
}

// ---------- task ----------
function ledger(events, withTask = false) {
  let day = '';
  return events.map((e) => {
    const d = dayLabel(e.created_at);
    const header = withTask && d !== day ? `<li style="display:block;border:0;padding:0"><div class="day">${esc(d)}</div></li>` : '';
    day = d;
    const actor = e.actor ? { name: e.actor, kind: e.actor_kind } : null;
    return header + html`<li><span class="when">${withTask ? clock(e.created_at) : agoLong(e.created_at)}</span>
      ${raw(actor ? av(actor) : '<span class="av" title="Kunla">K</span>')}
      <div class="what"><b>${e.actor || 'Kunla'}</b> ${VERB[e.type] || e.type.replace(/_/g, ' ')}
        ${raw(withTask ? html` <a href="#/t/${e.key}" class="key">${e.key}</a> ${e.title}` : '')}
        ${raw(e.note ? html`<div class="note">${e.note}</div>` : '')}</div></li>`;
  }).join('');
}

async function viewTask(key) {
  renderSide('board', inboxCount);
  const t = await api('GET', `/api/tasks/${encodeURIComponent(key)}`);
  const mine = t.assignee?.id === me.id;
  const actions = [];
  if (t.status === 'ready') actions.push(html`<button class="primary" data-act="click:claim">Take this task</button>`);
  if (t.status === 'in_progress' && mine) actions.push(html`<button class="primary" data-act="click:showSubmit">Submit for review</button>`);
  if (['ready', 'in_progress', 'blocked'].includes(t.status)) actions.push(html`<button class="ghost" data-act="click:markDone">Mark done</button>`);
  $app.innerHTML = html`<div class="page"><div class="task">
    <div class="task-main">
      <div class="stack" style="gap:10px">
        <div class="byline"><a href="#/board/${t.project.key}" class="muted">${t.project.name}</a><span class="key">${t.key}</span>
          ${raw(t.origin === 'logged' ? '<span class="muted">Logged from a conversation</span>' : '')}</div>
        <h1>${t.title}</h1>
        <div class="tag">${raw(st(t.status))}${STATUS[t.status]}</div>
      </div>
      ${raw(t.status === 'review' && !mine ? html`<div><div class="section-label">Waiting for review</div>${raw(deliverables(t.deliverables))}${raw(reviewControls(t.key))}</div>` : '')}
      ${raw(t.status === 'blocked' ? html`<div><div class="section-label">Question</div><p class="quote">${t.blocked_question}</p>
        <form class="decide" data-act="submit:answer" data-key="${t.key}"><textarea name="answer" required aria-label="Answer" style="min-height:60px"></textarea><div class="row"><button class="primary">Send answer</button></div></form></div>` : '')}
      <div><div class="section-label">Brief</div><p class="prose">${t.brief || 'No brief yet.'}</p></div>
      ${raw(t.criteria.length ? html`<div><div class="section-label">Done when</div><ul class="criteria">${join(t.criteria.map((c) => html`<li>${c}</li>`))}</ul></div>` : '')}
      ${raw(actions.length ? `<div class="actions">${actions.join('')}</div>` : '')}
      <form class="composer" data-act="submit:submit" id="submitform" hidden>
        <div class="field"><label for="sf-s">Summary</label><input id="sf-s" name="summary" required></div>
        <div class="field"><label for="sf-u">Link to the work</label><input id="sf-u" name="url" required type="url" placeholder="https://"></div>
        <div class="row"><button class="primary">Submit</button></div></form>
      ${raw(t.status !== 'review' ? html`<div><div class="section-label">The work</div>${raw(t.deliverables.length ? deliverables(t.deliverables) : '<p class="muted">Nothing attached yet.</p>')}</div>` : '')}
      <div><div class="section-label">History</div><ul class="ledger">${raw(ledger(t.history))}</ul></div>
    </div>
    <aside>
      <dl class="facts">
        <dt>Worker</dt><dd>${raw(who(t.assignee, 'Anyone'))}</dd>
        <dt>Reviewer</dt><dd>${raw(who(t.reviewer, 'Any person'))}</dd>
        <dt>Created by</dt><dd>${raw(who(t.created_by))}</dd>
        <dt>Updated</dt><dd class="num">${agoLong(t.updated_at)}</dd>
        ${raw(t.review_rounds ? html`<dt>Reviews</dt><dd class="warn">Sent back ${t.review_rounds}×</dd>` : '')}
      </dl>
      <div class="aside-block"><div class="section-label" style="margin:0">Rules for ${t.project.key}</div>
        ${raw(t.rules.length ? html`<ul class="criteria" style="font-size:13px">${join(t.rules.map((r) => html`<li>${r.text}</li>`))}</ul>` : '<p class="muted" style="font-size:13px">None yet. They come from reviews.</p>')}</div>
      <div class="aside-block"><div class="section-label" style="margin:0">Cite in commits</div>
        <div class="cite" data-act="click:copy" title="Copy">${t.references.commit_trailer}</div>
        <div class="section-label" style="margin:6px 0 0">Cite in documents</div>
        <div class="cite" data-act="click:copy" title="Copy">${t.references.doc_source_line}</div></div>
    </aside></div></div>`;
  const refresh = () => viewTask(key);
  bind($app, {
    ...decisionHandlers(refresh),
    claim: async () => { await api('POST', `/api/tasks/${t.key}/claim`); refresh(); },
    markDone: async () => { await api('PATCH', `/api/tasks/${t.key}`, { status: 'done' }); refresh(); },
    showSubmit: () => { $('submitform').hidden = false; $('sf-s').focus(); },
    submit: async (f) => { const d = formData(f); await api('POST', `/api/tasks/${t.key}/submit`, { summary: d.summary, deliverables: [{ url: d.url }] }); refresh(); },
    copy: async (el) => {
      try { await navigator.clipboard.writeText(el.textContent); toast('Copied'); }
      catch { const r = document.createRange(); r.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(r); }
    },
  });
}

// ---------- progress ----------
async function viewStatus(project) {
  renderSide('status', inboxCount);
  const s = await api('GET', `/api/status${project ? `?project=${project}` : ''}`);
  const c = s.counts;
  const open = c.ready + c.inbox;
  const total = c.done + c.review + c.in_progress + c.blocked + open || 1;
  const working = s.who_is_on_what.filter((w) => w.tasks.some((t) => t.status === 'in_progress'));
  const names = (n) => n.length <= 2 ? n.join(' and ') : `${n.slice(0, 2).join(', ')} and ${n.length - 2} more`;
  const segs = [['done', c.done, 'var(--accent)'], ['review', c.review, 'var(--review)'], ['in_progress', c.in_progress, 'var(--ink-2)'], ['blocked', c.blocked, 'var(--attn)'], ['ready', open, 'var(--rule-strong)']];
  $app.innerHTML = html`<div class="page">
    <div class="page-head"><div><h1>${s.project ? s.project.name : 'Progress'}</h1></div>
      <div class="tools"><select aria-label="Project" data-act="change:project"><option value="">All projects</option>
      ${join(projects.map((x) => html`<option value="${x.key}" ${x.key === project ? 'selected' : ''}>${x.name}</option>`))}</select></div></div>
    <p class="headline"><b>${s.approved_last_7_days} approved</b> in the last 7 days. ${c.review ? raw(html`<b>${c.review}</b> waiting for review, `) : ''}${c.blocked ? raw(html`<b>${c.blocked} blocked</b>, `) : ''}<b>${c.in_progress}</b> in progress${raw(working.length ? html`, worked on by ${names(working.map((w) => w.member.name))}` : '')}.</p>
    <div class="meter" role="img" aria-label="Tasks by status">${join(segs.filter(([, n]) => n).map(([k, n, col]) => `<span style="flex:${n};background:${col}" title="${STATUS[k]}: ${n}"></span>`))}</div>
    <div class="legend">${join(segs.map(([k, n, col]) => html`<span><i style="background:${col}"></i>${k === 'ready' ? 'Not started' : STATUS[k]} <span class="num">${n}</span></span>`))}</div>
    <div class="stat-line">
      <div><span class="n">${s.agent_recorded_share == null ? '–' : s.agent_recorded_share + '%'}</span><span class="l">of updates this week recorded by agents</span></div>
      <div><span class="n">${Math.round((c.done / total) * 100)}%</span><span class="l">of all tasks done</span></div>
    </div>
    <div class="two">
      <div><div class="section-label">This week</div><ul class="ledger">${raw(ledger(s.recent, true) || '<li class="muted" style="display:block">No activity this week.</li>')}</ul></div>
      <div>
        ${raw(s.blocked.length ? html`<div class="section-label">Blocked</div><div class="who-list" style="margin-bottom:24px">${join(s.blocked.map((b) => html`<div><a href="#/t/${b.key}"><span class="key">${b.key}</span> ${b.title}</a><span class="muted">${b.question}</span></div>`))}</div>` : '')}
        <div class="section-label">Who is on what</div>
        <div class="who-list">${raw(s.who_is_on_what.map((w) => html`<div>${raw(who(w.member))}
          <div class="tasks">${join(w.tasks.map((t) => html`<a href="#/t/${t.key}">${raw(st(t.status))}<span class="key">${t.key}</span><span class="tt">${t.title}</span></a>`))}</div></div>`).join('') || '<p class="muted">Nobody is working on anything right now.</p>')}</div>
      </div></div></div>`;
  bind($app, { project: (el) => { location.hash = el.value ? `#/status/${el.value}` : '#/status'; } });
}

// ---------- team ----------
async function viewTeam(sub) {
  renderSide('team', inboxCount);
  const members = await api('GET', '/api/members');
  const admin = (me.roles || []).includes('admin');
  $app.innerHTML = html`<div class="page">
    <div class="page-head"><div><h1>Team</h1><p class="sub">People and agents. Each agent has a sponsor who answers for its work.</p></div>
      <div class="tools">${raw(admin ? '<button data-act="click:addPerson">Add a person</button>' : '')}<button class="primary" data-act="click:connect">Connect an agent</button></div></div>
    <div id="connect"></div>
    <div class="table-wrap"><table><thead><tr><th>Member</th><th>Sponsor</th><th class="num">Active</th><th class="num">Done</th><th>Approved first time</th><th class="num">Last seen</th></tr></thead>
    <tbody>${join(members.map((m) => html`<tr>
      <td><span class="who">${raw(av(m, 'lg'))}<span><span class="name">${m.name}</span>${raw(m.platform ? html`<br><span class="key">${m.platform}</span>` : '')}</span></span></td>
      <td>${m.sponsor || raw('<span class="muted">–</span>')}</td><td class="num">${m.active}</td><td class="num">${m.done}</td>
      <td>${raw(m.first_pass_rate == null ? '<span class="muted">No reviews yet</span>' : html`<span class="bar-mini"><i style="width:${m.first_pass_rate}%"></i></span><span class="num">${m.first_pass_rate}%</span> <span class="muted">of ${m.reviewed}</span>`)}</td>
      <td class="num muted">${m.last_active ? agoLong(m.last_active) : '–'}</td></tr>`))}</tbody></table></div></div>`;
  bind($app, { connect: () => showConnect('ai'), addPerson: () => showConnect('human') });
  if (sub === 'connect') showConnect('ai');
}

function showConnect(kind) {
  const box = $('connect');
  box.innerHTML = kind === 'ai' ? html`<div class="panel stack" style="margin-bottom:24px">
    <div><h2 style="font-size:16px;font-weight:600">Connect an agent</h2>
    <p class="muted">Each connection is its own member, so its work is credited to it and you are its sponsor.</p></div>
    <form class="stack" data-act="submit:create"><input type="hidden" name="kind" value="ai">
      <div class="row" style="align-items:flex-end">
        <div class="field" style="flex:2;min-width:200px"><label for="ca-n">Name</label><input id="ca-n" name="name" required value="${me.name}'s Claude Code"></div>
        <div class="field" style="flex:1;min-width:160px"><label for="ca-p">Agent</label><select id="ca-p" name="platform" style="width:100%"><option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="other">Other MCP agent</option></select></div>
        <button class="primary">Create connection</button></div></form>
    <p class="muted" style="font-size:13px">For claude.ai, add <span class="key" style="color:var(--ink)">${location.origin}/mcp</span> as a custom connector. You'll approve it on a Kunla page and it joins as its own member.</p></div>`
    : html`<div class="panel stack" style="margin-bottom:24px"><h2 style="font-size:16px;font-weight:600">Add a person</h2>
      <form class="row" data-act="submit:create" style="align-items:flex-end"><input type="hidden" name="kind" value="human">
      <div class="field" style="flex:1;min-width:200px"><label for="cp-n">Name</label><input id="cp-n" name="name" required></div><button class="primary">Add</button></form></div>`;
  bind(box, {
    create: async (f) => {
      const d = formData(f);
      const r = await api('POST', '/api/members', d);
      const origin = location.origin;
      box.innerHTML = html`<div class="panel stack" style="margin-bottom:24px">
        <div><h2 style="font-size:16px;font-weight:600">${r.member.name} is connected</h2><p class="muted">Copy the token now. It is shown only once.</p></div>
        <div class="secret">${r.token}</div>
        ${raw(d.kind === 'ai' && d.platform === 'claude-code' ? html`<div><div class="section-label">In your terminal</div><pre>export KUNLA_URL=${origin}
export KUNLA_TOKEN=${r.token}
claude plugin marketplace add spikinglabs/kunla
claude plugin install kunla@kunla</pre></div>` : '')}
        ${raw(d.kind === 'ai' && d.platform !== 'claude-code' ? html`<div><div class="section-label">MCP server</div><pre>URL     ${origin}/mcp
Header  Authorization: Bearer ${r.token}</pre></div>` : '')}
        ${raw(d.kind === 'human' ? '<p>Send it to them privately. They paste it on the sign-in page.</p>' : '')}</div>`;
    },
  });
}

// ---------- projects ----------
async function viewSettings() {
  renderSide('settings', inboxCount);
  const rules = await api('GET', '/api/rules');
  $app.innerHTML = html`<div class="page" style="max-width:820px">
    <div class="page-head"><div><h1>Projects</h1><p class="sub">The playbook and rules go to every agent with every task in the project.</p></div></div>
    ${join(projects.map((p) => html`<form class="panel stack" data-act="submit:save" data-key="${p.key}">
      <div class="row"><span class="key" style="font-size:13px">${p.key}</span><input name="name" value="${p.name}" aria-label="Project name" style="flex:1;font-weight:600"></div>
      <div class="field"><label for="pb-${p.key}">Playbook</label><textarea id="pb-${p.key}" name="playbook" style="min-height:120px;font-family:var(--mono);font-size:13px" placeholder="Style guide, how-tos, tools to use, things to avoid. Markdown.">${p.playbook}</textarea></div>
      <label class="check"><input type="checkbox" name="require_human_review" ${p.require_human_review ? 'checked' : ''}> Work must be approved by a person</label>
      <div><div class="section-label">Rules from reviews</div>
        ${raw(rules.filter((r) => r.project === p.key).map((r) => html`<label class="check" style="padding:6px 0;border-top:1px solid var(--rule)"><input type="checkbox" data-act="change:rule" data-id="${r.id}" ${r.active ? 'checked' : ''}><span>${r.text} <span class="muted" style="font-size:12px">${r.created_by}, ${agoLong(r.created_at)}</span></span></label>`).join('') || '<p class="muted">None yet. When you send work back, you can turn the correction into a rule.</p>')}</div>
      <div class="row"><button class="primary">Save</button></div></form>`))}
    <form class="panel stack" data-act="submit:create"><h2 style="font-size:16px;font-weight:600">New project</h2>
      <div class="row" style="align-items:flex-end">
        <div class="field" style="flex:2;min-width:180px"><label for="np-n">Name</label><input id="np-n" name="name" required placeholder="Weekly sales report"></div>
        <div class="field" style="flex:1;min-width:110px"><label for="np-k">Key</label><input id="np-k" name="key" required placeholder="SALES" maxlength="10" style="font-family:var(--mono);text-transform:uppercase"></div>
        <button class="primary">Create</button></div></form></div>`;
  bind($app, {
    save: async (f) => { const d = formData(f); await api('PATCH', `/api/projects/${f.dataset.key}`, { name: d.name, playbook: d.playbook, require_human_review: !!d.require_human_review }); projects = await api('GET', '/api/projects'); toast('Saved'); },
    create: async (f) => { await api('POST', '/api/projects', formData(f)); projects = await api('GET', '/api/projects'); viewSettings(); },
    rule: async (el) => { await api('PATCH', `/api/rules/${el.dataset.id}`, { active: el.checked }); toast(el.checked ? 'Rule turned on' : 'Rule turned off'); },
  });
}

// ---------- router ----------
async function route() {
  clearInterval(pollTimer);
  keyHandler = null;
  if (!token) return viewGate().catch((e) => toast(e.message));
  if (!me) {
    try { me = await api('GET', '/api/me'); projects = await api('GET', '/api/projects'); } catch { return; }
    $('gate').hidden = true;
    $('shell').hidden = false;
    refreshCount();
  }
  const [, view = 'inbox', arg] = (location.hash || '#/inbox').split('/');
  const render = {
    inbox: () => viewInbox(arg && decodeURIComponent(arg)), board: () => viewBoard(arg), status: () => viewStatus(arg),
    team: () => viewTeam(arg), settings: viewSettings, t: () => viewTask(decodeURIComponent(arg || '')),
  }[view] || (() => viewInbox());
  try { await render(); } catch (e) { toast(e.message); }
  // Poll quietly while visible, unless someone is typing or has a form open.
  if (['inbox', 'status', 'board'].includes(view)) {
    pollTimer = setInterval(() => {
      if (document.hidden || typing() || $app.querySelector('dialog[open], .composer:not([hidden])')) return;
      render().catch(() => {});
    }, 20000);
  }
}

document.addEventListener('keydown', (e) => keyHandler?.(e));
window.addEventListener('hashchange', route);
route();
