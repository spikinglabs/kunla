// Kunla web app: static, no build step. Talks to the same API the agents use.
const $app = document.getElementById('app');
const TOKEN_KEY = 'kunla.token';
let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch {}
let me = null;
let pollTimer = null;

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const html = (strings, ...vals) => strings.reduce((out, s, i) => out + s + (i < vals.length ? (vals[i]?.__raw ?? esc(vals[i])) : ''), '');
const raw = (s) => ({ __raw: s });
const ago = (iso) => {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};
const who = (m) => m ? html`<span class="pill ${m.kind}">${m.kind === 'ai' ? 'AI' : 'Person'}</span> ${m.name}` : '<span class="pill">Unassigned</span>';
const STATUS_LABEL = { inbox: 'Proposal', ready: 'Ready', in_progress: 'In progress', blocked: 'Blocked', review: 'In review', done: 'Done', declined: 'Declined' };

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (res.status === 401 && path !== '/api/setup') { signOut(); throw new Error('Signed out'); }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

function signOut() {
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
  token = null; me = null;
  location.hash = '#/';
  route();
}

// Bind form submissions and buttons by data attributes after each render.
function bind(handlers) {
  $app.querySelectorAll('[data-act]').forEach((el) => {
    const [ev, name] = el.dataset.act.split(':');
    el.addEventListener(ev, async (e) => {
      e.preventDefault();
      try { await handlers[name](el, e); } catch (err) { toast(err.message); }
    });
  });
}
const formData = (form) => Object.fromEntries(new FormData(form).entries());

// ---------- sign in and setup ----------
async function viewSignIn() {
  document.getElementById('top').hidden = true;
  const s = await api('GET', '/api/setup');
  if (!s.set_up) {
    $app.innerHTML = html`<div class="narrow card">
      <h1>Set up Kunla</h1>
      <p class="sub">One record of everyone's work, people and AIs, and the decisions it needs from you.</p>
      <form data-act="submit:setup">
        <label>Your name</label><input name="name" required placeholder="L">
        <label>First project</label><input name="project_name" required placeholder="Q1 campaign">
        <label>Project key (prefix for task keys like MKT-42)</label><input name="project_key" required placeholder="MKT" maxlength="10">
        ${raw(s.needs_setup_token ? html`<label>Setup token</label><input name="setup_token" required type="password">` : '')}
        <p><button class="primary">Create workspace</button></p>
      </form></div>`;
  } else {
    $app.innerHTML = html`<div class="narrow card">
      <h1>Sign in to Kunla</h1>
      <p class="sub">Paste your personal Kunla token. Whoever set up this workspace can make one for you on the Team page.</p>
      <form data-act="submit:signin"><label>Token</label><input name="token" required placeholder="kun_..." type="password">
      <p><button class="primary">Sign in</button></p></form></div>`;
  }
  bind({
    setup: async (f) => {
      const r = await api('POST', '/api/setup', formData(f));
      token = r.token; try { localStorage.setItem(TOKEN_KEY, token); } catch {}
      $app.innerHTML = html`<div class="narrow card"><h1>You're set up</h1>
        <p>This is your personal token. Save it in your password manager; it is shown only once and it signs you in on other devices.</p>
        <div class="secret">${token}</div><p><a class="btn primary" href="#/team">Next: connect your first AI</a></p></div>`;
    },
    signin: async (f) => {
      token = formData(f).token.trim();
      try { localStorage.setItem(TOKEN_KEY, token); } catch {}
      location.hash = '#/inbox'; route();
    },
  });
}

// ---------- decision inbox (home) ----------
function deliverableLinks(ds) {
  if (!ds?.length) return '<span class="pill warn">No deliverable link</span>';
  return ds.map((d) => !/^https?:\/\//i.test(d.url) ? html`<span>${d.url}</span>` : html`<a href="${d.url}" target="_blank" rel="noopener">${d.title || d.url}</a>`).join(' · ');
}

async function viewInbox() {
  const data = await api('GET', '/api/inbox');
  setCount(data.count);
  const items = data.items.map(({ kind, task: t }) => {
    const head = html`<div class="row"><span class="kind-label">${{ review: 'Review', question: 'Question', proposal: 'Proposal', flagged: 'Needs a look' }[kind]}</span>
      <a class="key" href="#/t/${t.key}">${t.key}</a><span class="spacer"></span><span class="key">${ago(t.updated_at)}</span></div>
      <h2 style="margin:6px 0"><a href="#/t/${t.key}" style="color:inherit">${t.title}</a></h2>`;
    if (kind === 'review') return html`<div class="card">${raw(head)}
      <div class="row">${raw(who(t.assignee))}</div>
      ${raw(t.summary ? html`<p class="summary">${t.summary}</p>` : '')}
      ${raw(t.criteria.length ? html`<ul class="criteria">${raw(t.criteria.map((c) => html`<li>${c}</li>`).join(''))}</ul>` : '')}
      <p>${raw(deliverableLinks(t.deliverables))}</p>
      ${raw(reviewForm(t.key))}</div>`;
    if (kind === 'question') return html`<div class="card">${raw(head)}
      <div class="row">${raw(who(t.assignee))} asks:</div><p class="summary"><strong>${t.blocked_question}</strong></p>
      <form data-act="submit:answer" data-key="${t.key}" class="row"><input name="answer" required placeholder="Your answer" style="flex:1"><button class="primary">Answer</button></form></div>`;
    if (kind === 'proposal') return html`<div class="card">${raw(head)}
      <div class="row">Proposed by ${raw(who(t.created_by))}</div>${raw(t.brief ? html`<p class="brief">${t.brief}</p>` : '')}
      <div class="row"><button class="primary" data-act="click:triage" data-key="${t.key}" data-accept="1">Accept</button>
      <button data-act="click:triage" data-key="${t.key}" data-accept="0">Decline</button></div></div>`;
    return html`<div class="card">${raw(head)}<p>${t.review_rounds} review rounds so far. The brief may need rewriting, or a person should take it over.</p></div>`;
  });
  $app.innerHTML = html`<h1>Decisions waiting on you</h1>
    <p class="sub">Reviews, questions and proposals from people and AIs. Everything else updates itself.</p>
    ${raw(items.join('') || '<div class="empty">Nothing needs you right now.</div>')}`;
  bind(inboxHandlers(viewInbox));
}

function reviewForm(key) {
  return html`<form data-act="submit:review" data-key="${key}">
    <div class="row"><button class="primary" name="verdict" value="approved" data-act="click:approve" data-key="${key}">Approve</button>
    <button type="button" data-act="click:showChanges">Request changes</button></div>
    <div class="changes" hidden>
      <label>What was wrong</label><textarea name="what_was_wrong" placeholder="Prices were in USD only"></textarea>
      <label class="check"><input type="checkbox" name="make_rule" data-act="change:toggleRule"> Apply next time: turn this into a project rule</label>
      <input name="rule" hidden placeholder="Always show prices in EUR and USD">
      <p><button class="primary">Send back with changes</button></p>
    </div></form>`;
}

function inboxHandlers(refresh) {
  return {
    approve: async (el) => { await api('POST', `/api/tasks/${el.dataset.key}/review`, { verdict: 'approved' }); toast(`${el.dataset.key} approved`); refresh(); },
    showChanges: (el) => { el.closest('form').querySelector('.changes').hidden = false; },
    toggleRule: (el) => { const r = el.closest('form').querySelector('[name=rule]'); r.hidden = !el.checked; if (el.checked) r.focus(); },
    review: async (f) => {
      const d = formData(f);
      await api('POST', `/api/tasks/${f.dataset.key}/review`, { verdict: 'changes_requested', what_was_wrong: d.what_was_wrong, rule: d.make_rule ? d.rule : undefined });
      toast(d.make_rule && d.rule ? 'Sent back, and the rule is saved for next time' : 'Sent back with changes'); refresh();
    },
    answer: async (f) => { await api('POST', `/api/tasks/${f.dataset.key}/answer`, formData(f)); toast('Answered'); refresh(); },
    triage: async (el) => { await api('POST', `/api/tasks/${el.dataset.key}/triage`, { accept: el.dataset.accept === '1' }); refresh(); },
  };
}

function setCount(n) { const c = document.getElementById('inbox-count'); c.textContent = n || ''; c.hidden = !n; }

// ---------- board ----------
let boardProject = '';
async function viewBoard() {
  const [tasks, projects] = await Promise.all([
    api('GET', `/api/tasks?limit=300${boardProject ? `&project=${boardProject}` : ''}`),
    api('GET', '/api/projects'),
  ]);
  const cols = [['ready', 'Ready'], ['in_progress', 'In progress'], ['blocked', 'Blocked'], ['review', 'In review'], ['done', 'Done']];
  const card = (t) => html`<a class="card" href="#/t/${t.key}" style="display:block;color:inherit;text-decoration:none">
    <div class="key">${t.key}${t.origin === 'logged' ? ' · logged' : ''}</div><div class="title">${t.title}</div>
    <div class="row" style="margin-top:6px;font-size:13px">${raw(t.assignee ? who(t.assignee) : '')}</div></a>`;
  $app.innerHTML = html`<div class="row"><h1>Board</h1><span class="spacer"></span>
    <select data-act="change:project" style="width:auto"><option value="">All projects</option>
      ${raw(projects.map((p) => html`<option value="${p.key}" ${p.key === boardProject ? 'selected' : ''}>${p.key} · ${p.name}</option>`).join(''))}</select>
    <button class="primary" data-act="click:newTask">New task</button></div>
    <p class="sub">${proposalsLine(tasks.filter((t) => t.status === 'inbox').length)}</p>
    <div class="board">${raw(cols.map(([s, label]) => {
      const list = tasks.filter((t) => t.status === s).slice(0, s === 'done' ? 20 : 200);
      return html`<div class="col"><h3>${label} · ${list.length}</h3>${raw(list.map(card).join(''))}</div>`;
    }).join(''))}</div>
    ${raw(newTaskDialog(projects))}`;
  bind({
    project: (el) => { boardProject = el.value; viewBoard(); },
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

const proposalsLine = (n) => (n === 0 ? 'No proposals waiting.' : n === 1 ? 'One proposal waits in the inbox.' : `${n} proposals wait in the inbox.`);

function newTaskDialog(projects) {
  return html`<dialog><form data-act="submit:createTask">
    <h2 style="margin-top:0">New task</h2>
    <label>Project</label><select name="project">${raw(projects.map((p) => html`<option value="${p.key}" ${p.key === boardProject ? 'selected' : ''}>${p.key} · ${p.name}</option>`).join(''))}</select>
    <label>Title</label><input name="title" required>
    <label>Brief: the goal and the context an AI needs to act</label><textarea name="brief"></textarea>
    <label>Acceptance criteria, one per line</label><textarea name="criteria" style="min-height:60px"></textarea>
    <label>Assign to (name, optional)</label><input name="assignee" placeholder="Anyone can claim it">
    <p class="row"><button class="primary">Create</button><button type="button" data-act="click:closeDialog">Cancel</button></p>
  </form></dialog>`;
}

// ---------- task page ----------
async function viewTask(key) {
  const t = await api('GET', `/api/tasks/${encodeURIComponent(key)}`);
  const isMine = t.assignee?.id === me.id;
  const actions = [];
  if (t.status === 'ready') actions.push(html`<button class="primary" data-act="click:claim">Take it</button>`);
  if (t.status === 'in_progress' && isMine) actions.push(html`<button data-act="click:showSubmit">Submit for review</button>`);
  if (['ready', 'in_progress', 'blocked'].includes(t.status)) actions.push(html`<button data-act="click:setStatus" data-status="done">Mark done</button>`);
  const history = t.history.map((e) => html`<li><span class="when">${ago(e.created_at)}</span> ·
    <strong>${e.actor || 'Kunla'}</strong> ${e.actor_kind === 'ai' ? raw('<span class="pill ai">AI</span>') : ''} ${e.type.replace(/_/g, ' ')}
    ${raw(e.note ? html`<div class="brief">${e.note}</div>` : '')}</li>`).join('');
  $app.innerHTML = html`<div class="row"><span class="key">${t.key} · ${t.project.name}</span><span class="pill">${STATUS_LABEL[t.status]}</span>
    ${raw(t.origin === 'logged' ? '<span class="pill">Logged from a chat</span>' : '')}</div>
    <h1>${t.title}</h1>
    <div class="grid2"><div>
      ${raw(t.status === 'review' && !isMine ? html`<div class="card"><h2 style="margin-top:0">Your review</h2><p>${raw(deliverableLinks(t.deliverables))}</p>${raw(reviewForm(t.key))}</div>` : '')}
      ${raw(t.status === 'blocked' ? html`<div class="card"><strong>Blocked:</strong> ${t.blocked_question}
        <form data-act="submit:answer" data-key="${t.key}" class="row" style="margin-top:8px"><input name="answer" required placeholder="Your answer" style="flex:1"><button class="primary">Answer</button></form></div>` : '')}
      <div class="card"><h2 style="margin-top:0">Brief</h2><div class="brief">${t.brief || 'No brief yet.'}</div>
        ${raw(t.criteria.length ? html`<h2>Acceptance criteria</h2><ul class="criteria">${raw(t.criteria.map((c) => html`<li>${c}</li>`).join(''))}</ul>` : '')}
        <div class="row" style="margin-top:12px">${raw(actions.join(''))}</div>
        <form data-act="submit:submit" class="submitform" hidden><label>Summary</label><input name="summary" required>
          <label>Deliverable link</label><input name="url" required type="url"><p><button class="primary">Submit</button></p></form>
      </div>
      <div class="card"><h2 style="margin-top:0">Deliverables</h2><p>${raw(deliverableLinks(t.deliverables))}</p></div>
      <div class="card"><h2 style="margin-top:0">History</h2><ul class="timeline">${raw(history)}</ul></div>
    </div><div>
      <div class="card"><div class="kind-label">Worker</div><p>${raw(who(t.assignee))}</p>
        <div class="kind-label">Reviewer</div><p>${raw(t.reviewer ? who(t.reviewer) : 'Any person')}</p>
        <div class="kind-label">Created by</div><p>${raw(who(t.created_by))}</p>
        ${raw(t.review_rounds ? html`<p class="pill warn">${t.review_rounds} review round(s)</p>` : '')}</div>
      <div class="card"><div class="kind-label">Cite this task</div>
        <p class="key" style="word-break:break-all">${t.references.commit_trailer}</p>
        <p class="key">${t.references.doc_source_line}</p></div>
      <div class="card"><div class="kind-label">Project rules sent with this task</div>
        ${raw(t.rules.length ? html`<ul class="criteria">${raw(t.rules.map((r) => html`<li>${r.text}</li>`).join(''))}</ul>` : '<p class="sub">None yet. Rules come from reviews.</p>')}</div>
    </div></div>`;
  const refresh = () => viewTask(key);
  bind({
    ...inboxHandlers(refresh),
    claim: async () => { await api('POST', `/api/tasks/${t.key}/claim`); refresh(); },
    setStatus: async (el) => { await api('PATCH', `/api/tasks/${t.key}`, { status: el.dataset.status }); refresh(); },
    showSubmit: () => { $app.querySelector('.submitform').hidden = false; },
    submit: async (f) => { const d = formData(f); await api('POST', `/api/tasks/${t.key}/submit`, { summary: d.summary, deliverables: [{ url: d.url }] }); refresh(); },
  });
}

// ---------- progress ----------
async function viewStatus(project) {
  const [s, projects] = await Promise.all([api('GET', `/api/status${project ? `?project=${project}` : ''}`), api('GET', '/api/projects')]);
  const c = s.counts;
  const total = Object.entries(c).filter(([k]) => k !== 'declined').reduce((a, [, n]) => a + n, 0) || 1;
  const seg = (n, color) => `<span style="width:${(n / total) * 100}%;background:${color}"></span>`;
  $app.innerHTML = html`<div class="row"><h1>Progress</h1><span class="spacer"></span>
    <select data-act="change:project" style="width:auto"><option value="">All projects</option>
    ${raw(projects.map((p) => html`<option value="${p.key}" ${p.key === project ? 'selected' : ''}>${p.key} · ${p.name}</option>`).join(''))}</select></div>
    <p class="sub">Built from what people and agents did. Nobody wrote a status update.</p>
    <div class="stats">
      <div class="stat"><div class="n">${c.done}</div><div class="l">Done</div></div>
      <div class="stat"><div class="n">${c.in_progress}</div><div class="l">In progress</div></div>
      <div class="stat"><div class="n">${c.review}</div><div class="l">In review</div></div>
      <div class="stat"><div class="n">${c.blocked}</div><div class="l">Blocked</div></div>
      <div class="stat"><div class="n">${c.ready + c.inbox}</div><div class="l">Waiting to start</div></div>
      <div class="stat"><div class="n">${s.agent_recorded_share ?? '–'}${s.agent_recorded_share == null ? '' : '%'}</div><div class="l">Updates recorded by agents, 7 days</div></div>
    </div>
    <div class="bar" title="Done, review, in progress, blocked, waiting">${raw(seg(c.done, 'var(--ok)') + seg(c.review, 'var(--accent)') + seg(c.in_progress, 'var(--ai)') + seg(c.blocked, 'var(--warn)'))}</div>
    <div class="grid2"><div>
      <h2>Recent activity</h2><div class="card"><ul class="timeline">${raw(s.recent.map((e) => html`<li><span class="when">${ago(e.created_at)}</span> ·
        <strong>${e.actor || 'Kunla'}</strong> ${e.type.replace(/_/g, ' ')} <a href="#/t/${e.key}">${e.key}</a> ${e.title}
        ${raw(e.note ? html`<div class="brief sub" style="margin:2px 0 0">${e.note}</div>` : '')}</li>`).join('') || '<li class="sub">No activity this week.</li>')}</ul></div>
    </div><div>
      <h2>Who is on what</h2>${raw(s.who_is_on_what.map((w) => html`<div class="card"><div>${raw(who(w.member))}</div>
        <ul class="criteria">${raw(w.tasks.map((t) => html`<li><a href="#/t/${t.key}">${t.key}</a> ${t.title} <span class="pill">${STATUS_LABEL[t.status]}</span></li>`).join(''))}</ul></div>`).join('') || '<p class="sub">Nobody is working on anything.</p>')}
      ${raw(s.blocked.length ? html`<h2>Blocked</h2>${raw(s.blocked.map((b) => html`<div class="card"><a href="#/t/${b.key}">${b.key}</a> ${b.title}<div class="sub" style="margin:4px 0 0">${b.question}</div></div>`).join(''))}` : '')}
    </div></div>`;
  bind({ project: (el) => { location.hash = el.value ? `#/status/${el.value}` : '#/status'; } });
}

// ---------- team ----------
async function viewTeam() {
  const members = await api('GET', '/api/members');
  $app.innerHTML = html`<div class="row"><h1>Team</h1><span class="spacer"></span><button class="primary" data-act="click:connect">Connect an AI</button>
    ${raw(JSON.parse(me.rolesJson || '[]').includes('admin') ? '<button data-act="click:addPerson">Add a person</button>' : '')}</div>
    <p class="sub">People and AIs side by side. Each AI has a sponsor who is accountable for it.</p>
    <div class="card" style="overflow-x:auto"><table><thead><tr><th>Member</th><th>Sponsor</th><th>Active</th><th>Done</th><th>First-pass approval</th><th>Last active</th></tr></thead>
    <tbody>${raw(members.map((m) => html`<tr><td>${raw(who(m))}${raw(m.platform ? html` <span class="key">${m.platform}</span>` : '')}</td>
      <td>${m.sponsor || ''}</td><td>${m.active}</td><td>${m.done}</td>
      <td>${m.first_pass_rate == null ? '–' : m.first_pass_rate + '% of ' + m.reviewed}</td><td>${ago(m.last_active)}</td></tr>`).join(''))}</tbody></table></div>
    <div id="connect"></div>`;
  bind({
    connect: () => showConnect('ai'),
    addPerson: () => showConnect('human'),
  });
}

function showConnect(kind) {
  const box = document.getElementById('connect');
  box.innerHTML = kind === 'ai' ? html`<div class="card"><h2 style="margin-top:0">Connect an AI</h2>
    <p class="sub">Each connection becomes its own AI member with you as its sponsor, so its work is attributed correctly.</p>
    <form data-act="submit:create"><input type="hidden" name="kind" value="ai">
      <label>Name</label><input name="name" required value="${me.name}'s Claude Code">
      <label>Platform</label><select name="platform"><option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="other">Other agent</option></select>
      <p><button class="primary">Create connection</button></p></form>
    <p class="sub">For claude.ai, add <code>${location.origin}/mcp</code> as a custom connector instead. It signs in through this page and creates its member for you.</p></div>`
    : html`<div class="card"><h2 style="margin-top:0">Add a person</h2><form data-act="submit:create"><input type="hidden" name="kind" value="human">
      <label>Name</label><input name="name" required><p><button class="primary">Add</button></p></form></div>`;
  bind({
    create: async (f) => {
      const d = formData(f);
      const r = await api('POST', '/api/members', d);
      const origin = location.origin;
      box.innerHTML = html`<div class="card"><h2 style="margin-top:0">${r.member.name} is connected</h2>
        <p>Its token is shown only once:</p><div class="secret">${r.token}</div>
        ${raw(d.kind === 'ai' ? html`<h2>Claude Code</h2><p>Install the plugin and give it the token:</p>
<pre>export KUNLA_URL=${origin}
export KUNLA_TOKEN=${r.token}
claude plugin marketplace add spikinglabs/kunla
claude plugin install kunla@kunla</pre>
<h2>Any other MCP agent (Codex, Cursor, Gemini CLI...)</h2>
<pre>URL:    ${origin}/mcp
Header: Authorization: Bearer ${r.token}</pre>` : '<p>Send it to them privately; they paste it on the sign-in page.</p>')}</div>`;
    },
  });
}

// ---------- projects and rules ----------
async function viewSettings() {
  const [projects, rules] = await Promise.all([api('GET', '/api/projects'), api('GET', '/api/rules')]);
  $app.innerHTML = html`<h1>Projects</h1><p class="sub">Each project has a playbook and rules that are sent to every agent with every task.</p>
    ${raw(projects.map((p) => html`<div class="card"><form data-act="submit:save" data-key="${p.key}">
      <div class="row"><span class="key">${p.key}</span><input name="name" value="${p.name}" style="flex:1"></div>
      <label>Playbook (Markdown: style guide, SOPs, tools, what to avoid)</label><textarea name="playbook" style="min-height:120px">${p.playbook}</textarea>
      <label class="check"><input type="checkbox" name="require_human_review" ${p.require_human_review ? 'checked' : ''}> A person must review work in this project</label>
      <h2>Rules from reviews</h2>
      ${raw(rules.filter((r) => r.project === p.key).map((r) => html`<label class="check"><input type="checkbox" data-act="change:rule" data-id="${r.id}" ${r.active ? 'checked' : ''}> ${r.text} <span class="key">by ${r.created_by}, ${ago(r.created_at)}</span></label>`).join('') || '<p class="sub">No rules yet. Tick "apply next time" when you request changes.</p>')}
      <p><button class="primary">Save</button></p></form></div>`).join(''))}
    <div class="card"><h2 style="margin-top:0">New project</h2><form data-act="submit:create" class="row">
      <input name="name" required placeholder="Weekly sales report" style="flex:2"><input name="key" required placeholder="SALES" style="flex:1" maxlength="10"><button class="primary">Create</button></form></div>`;
  bind({
    save: async (f) => { const d = formData(f); await api('PATCH', `/api/projects/${f.dataset.key}`, { name: d.name, playbook: d.playbook, require_human_review: !!d.require_human_review }); toast('Saved'); },
    create: async (f) => { await api('POST', '/api/projects', formData(f)); viewSettings(); },
    rule: async (el) => { await api('PATCH', `/api/rules/${el.dataset.id}`, { active: el.checked }); toast(el.checked ? 'Rule on' : 'Rule off'); },
  });
}

// ---------- router ----------
async function route() {
  clearInterval(pollTimer);
  if (!token) return viewSignIn().catch((e) => toast(e.message));
  if (!me) {
    try { const w = await api('GET', '/api/me'); me = { ...w, rolesJson: JSON.stringify(w.roles) }; } catch { return; }
    document.getElementById('top').hidden = false;
    document.getElementById('me').innerHTML = html`${me.name} · <a href="#" id="signout">Sign out</a>`;
    document.getElementById('signout').onclick = (e) => { e.preventDefault(); signOut(); };
  }
  const [, view, arg] = (location.hash || '#/inbox').split('/');
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (view || 'inbox')));
  const render = {
    inbox: viewInbox, board: viewBoard, status: () => viewStatus(arg), team: viewTeam, settings: viewSettings,
    t: () => viewTask(decodeURIComponent(arg || '')),
  }[view || 'inbox'] || viewInbox;
  try { await render(); } catch (e) { toast(e.message); }
  // Live enough: poll quietly while the page is visible, except where you might be typing.
  if (['inbox', 'status', 'board', undefined, ''].includes(view)) {
    pollTimer = setInterval(() => {
      if (document.hidden || $app.contains(document.activeElement) && document.activeElement.matches('input,textarea,select')) return;
      if ($app.querySelector('dialog[open], .changes:not([hidden])')) return;
      render().catch(() => {});
    }, 20000);
  }
  if (view !== 'inbox') api('GET', '/api/inbox').then((d) => setCount(d.count)).catch(() => {});
}

window.addEventListener('hashchange', route);
route();
