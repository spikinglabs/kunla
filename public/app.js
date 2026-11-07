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
const STATUS = { inbox: 'Proposed', ready: 'Ready', in_progress: 'In progress', blocked: 'Waiting on an answer', review: 'In review', done: 'Done', declined: 'Declined' };
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
        <div class="field"><label for="g-pname">First project</label><input id="g-pname" name="project_name" required placeholder="Q1 campaign"></div>
        <div class="field"><label for="g-pkey">Task key prefix</label><input id="g-pkey" name="project_key" required placeholder="MKT" maxlength="10" style="font-family:var(--mono);text-transform:uppercase">
          <span class="muted" style="font-size:12px">Work in this project is numbered MKT-1, MKT-2, and every commit, doc and message can cite it.</span></div>
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
const NAV = [['', 'Briefing'], ['map', 'Map'], ['tasks', 'Tasks'], ['team', 'Team'], ['playbook', 'Playbook']];
function renderShell(view) {
  const link = ([k, label]) => html`<a href="#/${k}" class="${k === view ? 'on' : ''}">${label}${raw(k === '' && decisionCount ? `<span class="n">${decisionCount}</span>` : '')}</a>`;
  $('nav').innerHTML = NAV.map(link).join('');
  $('tabbar').innerHTML = NAV.slice(0, 4).map(link).join('');
  $('me').innerHTML = av({ name: me.name, kind: 'human' });
  $('me').title = `${me.name}: sign out`;
}
$('me').onclick = () => { if (confirm(`Sign out ${me?.name}?`)) signOut(); };
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
      <div class="byline">${raw(who(worker, 'Someone'))}<span>sent this ${agoLong(t.updated_at)}${round}</span></div>
      ${raw(t.summary ? html`<p class="said">${t.summary}</p>` : '')}
      ${raw(t.deliverables?.length ? html`<div class="links">${join(t.deliverables.map((d) => html`<a class="pill" href="${d.url}" target="_blank" rel="noopener">${d.title || new URL(d.url).hostname} ↗</a>`))}</div>` : '')}
      ${raw(t.criteria?.length ? html`<div><div class="label" style="margin-bottom:6px">Tick what's met</div><div class="checks">${join(t.criteria.map((c, i) => html`<label class="check"><input type="checkbox" name="c${i}" data-crit="${c}"><span>${c}</span></label>`))}</div></div>` : '')}
      <div class="field"><label for="n-${t.key}">Note to ${callName(worker) || 'the worker'}</label>
        <textarea id="n-${t.key}" name="note" rows="2" placeholder="Optional when approving. Say what to fix when sending it back."></textarea></div>
      <div class="teach" data-teach>
        <label class="check"><input type="checkbox" name="teach" data-act="change:teach"><span><b>Teach the team.</b> <span class="hint">Turn this into a rule sent with every future ${p?.key ?? ''} task, to every agent.</span></span></label>
        <div hidden data-rule><input name="rule" aria-label="Rule" placeholder="e.g. Every pricing tier shows a price."></div>
      </div>
      <div class="acts">
        <button class="btn go" name="v" value="approved">Approve <kbd>A</kbd></button>
        <button class="btn" type="button" data-act="click:changes">Send back <kbd>C</kbd></button>
        <span class="spacer"></span>
        ${raw(solo ? '' : '<button class="btn quiet" type="button" data-act="click:later">Later <kbd>L</kbd></button>')}
      </div></form>`;
  }
  if (item.kind === 'question') {
    return html`<form class="decision ${solo ? '' : 'card'}" data-key="${t.key}" data-act="submit:answer">
      ${raw(head('Question'))}${raw(title)}
      <div class="byline">${raw(who(worker, 'An agent'))}<span>is stuck and asked ${agoLong(t.updated_at)}</span></div>
      <p class="ask">“${t.blocked_question}”</p>
      <div class="field"><label for="a-${t.key}">Your answer</label><textarea id="a-${t.key}" name="answer" rows="3" required placeholder="${callName(worker) || 'It'} continues as soon as you send this."></textarea></div>
      <div class="acts"><button class="btn go">Send answer <kbd>⌘↵</kbd></button><span class="spacer"></span>
        ${raw(solo ? '' : '<button class="btn quiet" type="button" data-act="click:later">Later <kbd>L</kbd></button>')}</div></form>`;
  }
  if (item.kind === 'proposal') {
    return html`<div class="decision ${solo ? '' : 'card'}" data-key="${t.key}">
      ${raw(head('Proposal'))}${raw(title)}
      <div class="byline">${raw(who(t.created_by, 'Someone'))}<span>suggested this ${agoLong(t.created_at)}</span></div>
      ${raw(t.brief ? html`<p class="said">${t.brief}</p>` : '')}
      <div class="acts"><button class="btn go" data-act="click:accept">Make it ready <kbd>A</kbd></button>
        <button class="btn" data-act="click:decline">Decline</button><span class="spacer"></span>
        ${raw(solo ? '' : '<button class="btn quiet" type="button" data-act="click:later">Later <kbd>L</kbd></button>')}</div></div>`;
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
    later: () => later?.(),
  };
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
  if (working) out.push(`${plural(working, 'agent')} ${working === 1 ? 'is' : 'are'} working now.`);
  if (blocked.length) out.push(html`<b>${blocked[0].name}</b> is waiting on an answer.`);
  return out.join(' ');
}

async function viewBriefing() {
  renderShell('');
  const [inbox, brief, pulse, rules, ...stats] = await Promise.all([
    api('GET', '/api/inbox'), api('GET', '/api/briefing?hours=24'), api('GET', '/api/pulse'), api('GET', '/api/rules'),
    ...projects.map((p) => api('GET', `/api/status?project=${p.key}`)),
  ]);
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
    if (typing() || e.metaKey || e.ctrlKey || e.altKey || !$('palette').hidden || !cur) return;
    const k = e.key.toLowerCase();
    const card = $app.querySelector('.decision');
    if (k === 'a') { e.preventDefault(); card.querySelector('.btn.go')?.click(); }
    else if (k === 'c' || k === 'r') { e.preventDefault(); card.querySelector('[data-act="click:changes"]')?.click(); }
    else if (k === 'l' || k === 'j') { e.preventDefault(); deck.i = (deck.i + 1) % items.length; viewBriefing(); }
    else if (k === 'k') { e.preventDefault(); deck.i = (deck.i - 1 + items.length) % items.length; viewBriefing(); }
    else if (k === 'enter' && cur) location.hash = `#/t/${cur.task.key}`;
  };
  // ⌘↵ sends an answer from the textarea.
  $app.querySelectorAll('textarea[name=answer]').forEach((ta) => ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ta.form.requestSubmit(); }));
}

function progress(s) {
  const c = s.counts;
  const total = Object.entries(c).filter(([k]) => k !== 'declined' && k !== 'inbox').reduce((a, [, n]) => a + n, 0) || 1;
  const order = ['done', 'review', 'in_progress', 'blocked', 'ready'];
  const words = { done: 'done', review: 'in review', in_progress: 'in progress', blocked: 'waiting', ready: 'ready' };
  return html`<a href="#/tasks/${s.project.key}"><div class="row" style="justify-content:space-between"><span><b style="font-weight:600">${s.project.name}</b> <span class="key">${s.project.key}</span></span>
    <span class="muted" style="font-size:12.5px">${s.agent_recorded_share != null ? s.agent_recorded_share + '% recorded by agents' : ''}</span></div>
    <div class="bar">${join(order.filter((k) => c[k]).map((k) => html`<span class="b-${k}" style="width:${(c[k] / total) * 100}%" title="${c[k]} ${words[k]}"></span>`))}</div>
    <div class="legend">${order.filter((k) => c[k]).map((k) => `${c[k]} ${words[k]}`).join(' · ') || 'No tasks yet'}</div></a>`;
}

// ---------- work map ----------
let mapDays = 5;
async function viewMap() {
  renderShell('map');
  const m = await api('GET', `/api/map?days=${mapDays}`);
  const S = new Date(m.start).getTime();
  const E = new Date(m.end).getTime();
  const pad = (E - S) * 0.03;
  const R = E + pad - S;
  const x = (iso) => ((new Date(iso).getTime() - S) / R) * 100;
  const days = [];
  const d0 = new Date(S); d0.setHours(0, 0, 0, 0);
  for (let d = new Date(d0); d.getTime() < E + pad; d.setDate(d.getDate() + 1)) days.push(new Date(d));
  const nights = days.map((d) => {
    const a = new Date(d); a.setHours(20, 0, 0, 0);
    const b = new Date(d); b.setDate(b.getDate() + 1); b.setHours(7, 0, 0, 0);
    const l = Math.max(0, (a.getTime() - S) / R * 100); const r = Math.min(100, (b.getTime() - S) / R * 100);
    return r > l ? `<i class="night" style="left:${l}%;width:${r - l}%"></i>` : '';
  }).join('') + (() => { const b = new Date(d0); b.setHours(7, 0, 0, 0); const r = (b.getTime() - S) / R * 100; return r > 0 ? `<i class="night" style="left:0;width:${r}%"></i>` : ''; })();
  const grid = days.map((d) => { const l = (d.getTime() - S) / R * 100; return l >= 0 ? `<i class="grid-line" style="left:${l}%"></i>` : ''; }).join('');
  const nowX = x(m.end);
  const lanes = m.lanes.filter((l) => l.segments.length || members.find((mm) => mm.id === l.id)?.active);
  const seg = (s) => {
    const l = Math.max(0, x(s.start));
    const r = Math.min(nowX, x(s.end ?? m.end));
    const w = Math.max(s.kind === 'decide' ? 0.6 : 0.35, r - l);
    const text = s.kind === 'decide' ? '' : s.kind === 'wait' ? s.label.replace(`${s.key} `, '') : s.title;
    return html`<a class="seg ${s.kind} ${s.live ? 'live' : ''}" href="#/t/${s.key}" style="left:${l}%;width:${w}%" title="${s.label} · ${when(s.start)}–${s.end ? clock(s.end) : 'now'}"><span>${text}</span></a>`;
  };
  const longest = Math.max(1, ...m.waits.map((w) => E - new Date(w.since).getTime()));
  $app.innerHTML = html`<div class="head"><div><h1>Work map</h1>
      <p class="sub">Who worked on what, person or agent. Solid is work, dashed is work waiting on someone, lime is a decision. Nobody filled this in; it comes from the record.</p></div>
      <div class="row">${join([3, 5, 7, 14].map((n) => html`<button class="pill ${n === mapDays ? 'on' : ''}" data-act="click:days" data-n="${n}">${n} days</button>`))}</div></div>
    <div class="card"><div class="map"><div class="map-in">
      <div class="map-days"><div></div><div class="track">${join(days.map((d) => { const l = (d.getTime() - S) / R * 100; return l >= -2 ? html`<span class="d" style="left:${Math.max(0, l)}%">${dayShort(d)}</span>` : ''; }))}<i class="now" style="left:${nowX}%"></i></div></div>
      ${join(lanes.map((l) => html`<div class="lane"><div class="who">${raw(av(l, '', l.segments.some((s) => s.live)))}<span class="grow"><span class="name" style="font-weight:600;font-size:14px">${l.name}</span>
        <small>${l.kind === 'ai' ? PLATFORM[l.platform] || 'Agent' : 'Person'}</small></span></div>
        <div class="track">${raw(nights)}${raw(grid)}${join(l.segments.map(seg))}<i class="now bare" style="left:${nowX}%"></i></div></div>`))}
    </div></div></div>
    <div class="row map-key" style="margin:14px 4px 0"><span><i style="background:var(--ink)"></i>Working</span><span><i style="border:1.5px dashed var(--wait)"></i>Waiting on someone</span>
      <span><i style="background:var(--lime)"></i>A decision</span><span><i style="background:var(--sunk)"></i>Night</span></div>
    <div class="card pad" style="margin-top:28px"><div class="section-t"><h2>Where work waits now</h2><span class="muted" style="font-size:13px">Oldest first. Each one is a person, not an agent.</span></div>
      ${raw(m.waits.length ? html`<div class="waits">${join(m.waits.map((w) => { const ms = E - new Date(w.since).getTime(); return html`<a href="#/t/${w.key}"><span class="key">${w.key}</span>
        <span class="t">${w.title}<small>${w.who}: ${w.label.replace(w.key + ' ', '')}</small></span><span class="len"><i style="width:${(ms / longest) * 100}%"></i></span><span class="for">${span(ms)}</span></a>`; }))}</div>`
      : '<p class="muted">Nothing is waiting. Every task is either moving or done.</p>')}</div>`;
  bind($app, { days: (el) => { mapDays = Number(el.dataset.n); viewMap(); } });
  const sc = $app.querySelector('.map');
  if (sc) sc.scrollLeft = sc.scrollWidth;
}

// ---------- task: review and teach ----------
const EVENT = {
  created: (e) => e.data?.status === 'inbox' ? 'proposed it' : 'wrote the brief', claimed: () => 'picked it up', work_logged: () => 'logged work',
  submitted: () => 'sent it for review', approved: () => 'approved it', changes_requested: () => 'sent it back', rule_added: () => 'taught the team a rule',
  blocked: () => 'asked a question', answered: () => 'answered', accepted: () => 'made it ready', declined: () => 'declined it',
  lease_expired: () => 'went quiet, so the claim lapsed', status: (e) => `moved it to ${STATUS[e.data?.to] || e.data?.to}`, flagged: () => 'flagged it', note: () => 'commented',
};
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
  const p = t.project;
  $app.innerHTML = html`<div class="task"><article>
      <div class="crumbs"><a href="#/tasks/${p.key}">${p.name}</a><span>/</span><span class="mono">${t.key}</span></div>
      <h1>${t.title}</h1>
      <div class="row"><span class="pill ${t.status === 'review' ? 'lime' : t.status === 'blocked' ? 'warn' : t.status === 'done' ? 'on' : ''}">${STATUS[t.status]}</span>
        <div class="people"><span>${raw(who(t.assignee, 'Nobody yet'))}</span>${raw(t.reviewer ? html`<span class="muted">reviewed by</span><span>${raw(who(t.reviewer))}</span>` : '')}
        ${raw(t.created_by ? html`<span class="muted">asked by ${t.created_by.name}</span>` : '')}</div></div>
      ${raw(decision ? html`<div class="card" style="margin-top:24px">${raw(decision)}</div>` : '')}
      ${raw(t.brief ? html`<div class="sec"><h3>Brief</h3><p class="prose">${t.brief}</p></div>` : '')}
      ${raw(t.criteria.length && !(t.status === 'review' && decision) ? html`<div class="sec"><h3>Done when</h3><ul class="crit ${t.status === 'done' ? 'met' : ''}">${join(t.criteria.map((c) => html`<li>${c}</li>`))}</ul></div>` : '')}
      ${raw(t.deliverables.length && !(t.status === 'review' && decision) ? html`<div class="sec"><h3>The work</h3><div class="links">${join(t.deliverables.map((d) => html`<a class="pill" href="${d.url}" target="_blank" rel="noopener">${d.title || d.url} ↗</a>`))}</div></div>` : '')}
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
        ${raw(t.rules.length ? html`<ol class="rules-mini" style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:8px;font-size:14px">${join(t.rules.map((r) => html`<li>${r.text}</li>`))}</ol>` : '<p class="s" style="color:#b9b6ac;font-size:13.5px">No rules yet in this project.</p>')}
        ${raw(t.playbook ? html`<details class="playbook"><summary>${p.name} playbook</summary><pre>${t.playbook}</pre></details>` : '')}</div>
      <div class="card pad"><h3>Cite it anywhere</h3><div class="cite">${join([['Commit trailer', t.references.commit_trailer], ['Branch', t.references.branch], ['Doc source line', t.references.doc_source_line], ['Link', t.references.link]].map(([l, v]) => html`<button type="button" data-act="click:copy" data-v="${v}"><small>${l}</small><code>${v}</code></button>`))}</div></div>
      ${raw(t.subtasks.length ? html`<div class="card pad"><h3>Follow-ups</h3><div class="done-list">${join(t.subtasks.map((s) => html`<a href="#/t/${s.key}"><span class="key">${s.key}</span><span class="t grow">${s.title}</span><span class="muted" style="font-size:12px">${STATUS[s.status]}</span></a>`))}</div></div>` : '')}
    </aside></div>`;
  const reload = () => viewTask(key);
  const text = () => $app.querySelector('.composer textarea').value.trim();
  bind($app, {
    ...decisionHandlers(reload),
    comment: async (f) => { if (!text()) throw new Error('Write something first.'); await api('POST', `/api/tasks/${t.key}/comment`, { text: text() }); toast('Added to the record.'); reload(); },
    copy: async (el) => { try { await navigator.clipboard.writeText(el.dataset.v); toast('Copied.'); } catch { toast(el.dataset.v); } },
  });
  $app.querySelectorAll('textarea[name=answer]').forEach((ta) => ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ta.form.requestSubmit(); }));
}

// ---------- tasks board ----------
async function viewTasks(project) {
  renderShell('tasks');
  const tasks = await api('GET', `/api/tasks${project ? '?project=' + project : ''}`);
  const cols = [['inbox', 'Proposed'], ['ready', 'Ready'], ['in_progress', 'In progress'], ['blocked', 'Waiting'], ['review', 'In review'], ['done', 'Done']];
  const p = projects.find((x) => x.key === project);
  $app.innerHTML = html`<div class="head"><div><h1>${p ? p.name : 'All tasks'}</h1><p class="sub">Agents move these themselves. You only step in where a card asks you to.</p></div>
      <button class="btn go" data-act="click:new">New task <kbd>⌘K</kbd></button></div>
    <div class="row" style="margin-bottom:18px"><a class="pill ${!project ? 'on' : ''}" href="#/tasks">All</a>${join(projects.map((x) => html`<a class="pill ${x.key === project ? 'on' : ''}" href="#/tasks/${x.key}">${x.key} · ${x.name}</a>`))}</div>
    <div class="cols">${join(cols.map(([s, label]) => { const list = tasks.filter((t) => t.status === s).slice(0, s === 'done' ? 12 : 50); return html`<section class="col"><h3><span>${label}</span><span>${tasks.filter((t) => t.status === s).length}</span></h3>
      <div class="list">${raw(list.length ? list.map((t) => html`<a class="card tcard" href="#/t/${t.key}"><span class="key">${t.key}</span><span class="t">${t.title}</span>
        <span class="f">${raw(who(t.assignee, s === 'ready' ? 'Anyone' : '—'))}<span class="key">${ago(t.updated_at)}</span></span></a>`).join('') : '<div class="empty-col">None</div>')}</div></section>`; }))}</div>`;
  bind($app, { new: () => openPalette(p ? `#${p.key} ` : '') });
}

// ---------- team ----------
async function viewTeam(sub) {
  renderShell('team');
  const [record, pulse] = await Promise.all([api('GET', '/api/members'), api('GET', '/api/pulse')]);
  members = record;
  const ps = new Map(pulse.map((p) => [p.id, p]));
  $app.innerHTML = html`<div class="head"><div><h1>Team</h1><p class="sub">People and agents side by side. Each agent works under its own name, with a person who sponsors it. Trust is earned from the record.</p></div>
      <div class="row"><button class="btn go" data-act="click:connect">Connect an agent</button><button class="btn" data-act="click:addPerson">Add a person</button></div></div>
    <div id="connect"></div>
    <div class="people-grid">${join(record.map((m) => { const p = ps.get(m.id) || {}; return html`<div class="card pad member">
      <div class="row" style="flex-wrap:nowrap">${raw(av(m, 'lg', p.live))}<div class="grow"><div class="nm">${m.name}</div><div class="muted" style="font-size:13px">${kindLine(m)}</div></div><span class="state ${p.state || 'idle'}">${p.state || 'idle'}</span></div>
      <div style="font-size:14px;color:var(--ink-2);min-height:21px">${raw(p.task ? html`<a href="#/t/${p.task.key}">${p.line}</a>` : esc(m.last_active ? `Last active ${agoLong(m.last_active)}` : 'Not active yet'))}</div>
      <div class="stats"><div><b>${m.done}</b><small>done</small></div><div><b>${m.first_pass_rate == null ? '–' : m.first_pass_rate + '%'}</b><small>first try</small></div><div><b>${m.active}</b><small>active</small></div></div></div>`; }))}</div>`;
  bind($app, { connect: () => showConnect('ai'), addPerson: () => showConnect('human') });
  if (sub === 'connect') showConnect('ai');
}

function showConnect(kind) {
  const box = $('connect');
  box.innerHTML = kind === 'ai' ? html`<div class="card pad stack" style="margin-bottom:24px">
    <div><h2 style="font-size:18px;font-weight:600;letter-spacing:-.02em">Connect an agent</h2>
    <p class="muted">It joins as its own member, so its work is credited to it and you are its sponsor.</p></div>
    <form class="row" data-act="submit:create" style="align-items:flex-end"><input type="hidden" name="kind" value="ai">
      <div class="field" style="flex:2;min-width:200px"><label for="ca-n">Name</label><input id="ca-n" name="name" required value="${me.name}'s Claude Code"></div>
      <div class="field" style="flex:1;min-width:160px"><label for="ca-p">Agent</label><select id="ca-p" name="platform"><option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="other">Other MCP agent</option></select></div>
      <button class="btn go">Create connection</button></form>
    <p class="muted" style="font-size:13.5px">For claude.ai, add <code style="color:var(--ink)">${location.origin}/mcp</code> as a custom connector. You approve it on a Kunla page and it joins under its own name.</p></div>`
    : html`<div class="card pad stack" style="margin-bottom:24px"><h2 style="font-size:18px;font-weight:600">Add a person</h2>
      <form class="row" data-act="submit:create" style="align-items:flex-end"><input type="hidden" name="kind" value="human">
      <div class="field" style="flex:1;min-width:200px"><label for="cp-n">Name</label><input id="cp-n" name="name" required></div><button class="btn go">Add</button></form></div>`;
  bind(box, {
    create: async (f) => {
      const d = formData(f);
      const r = await api('POST', '/api/members', d);
      const origin = location.origin;
      box.innerHTML = html`<div class="card pad stack" style="margin-bottom:24px">
        <div><h2 style="font-size:18px;font-weight:600">${r.member.name} is in</h2><p class="muted">Copy the token now. It is shown only once.</p></div>
        <div class="secret">${r.token}</div>
        ${raw(d.kind === 'ai' && d.platform === 'claude-code' ? html`<div class="stack" style="gap:8px"><div class="label">In your terminal</div><pre class="code">export KUNLA_URL=${origin}
export KUNLA_TOKEN=${r.token}
claude plugin marketplace add spikinglabs/kunla
claude plugin install kunla@kunla</pre><p class="muted" style="font-size:13.5px">From then on it picks up work with <code>/kunla:next</code>, cites the task in every commit, and records progress without being asked.</p></div>` : '')}
        ${raw(d.kind === 'ai' && d.platform !== 'claude-code' ? html`<div class="stack" style="gap:8px"><div class="label">MCP server</div><pre class="code">URL     ${origin}/mcp
Header  Authorization: Bearer ${r.token}</pre></div>` : '')}
        ${raw(d.kind === 'human' ? '<p>Send it to them privately. They paste it on the sign-in page.</p>' : '')}</div>`;
      members = await api('GET', '/api/members');
    },
  });
}

// ---------- playbook ----------
async function viewPlaybook() {
  renderShell('playbook');
  const rules = await api('GET', '/api/rules');
  $app.innerHTML = html`<div class="head"><div><h1>Playbook</h1><p class="sub">What every agent gets with every task: the project's playbook, plus the rules your reviews taught. Turn a rule off when it stops being true.</p></div></div>
    <div class="stack" style="gap:20px">${join(projects.map((p) => { const rs = rules.filter((r) => r.project === p.key); return html`<form class="card pad stack" data-act="submit:save" data-key="${p.key}">
      <div class="row"><span class="pill on mono">${p.key}</span><input name="name" value="${p.name}" aria-label="Project name" style="flex:1;font-weight:600;font-size:18px;border-color:transparent;background:transparent;padding-left:4px"></div>
      <div class="pb"><div class="field"><label for="pb-${p.key}">Playbook</label><textarea id="pb-${p.key}" name="playbook" placeholder="Voice, links, tools to use, things to avoid. Markdown.">${p.playbook}</textarea>
          <label class="check" style="margin-top:6px"><input type="checkbox" name="require_human_review" ${p.require_human_review ? 'checked' : ''}><span>Work must be approved by a person, not another agent</span></label></div>
        <div><div class="label" style="margin-bottom:6px">Rules from reviews</div>
          ${raw(rs.length ? rs.map((r) => html`<div class="rule-row"><input type="checkbox" class="switch" data-act="change:rule" data-id="${r.id}" ${r.active ? 'checked' : ''} aria-label="Rule on"><div class="grow"><div>${r.text}</div>
            <div class="m">${r.created_by}, ${agoLong(r.created_at)}${r.source_task ? ' · from ' + r.source_task : ''} · sent with ${plural(r.sent_with, 'task')}</div></div></div>`).join('')
          : '<p class="muted" style="font-size:14px">None yet. When you send work back, tick “Teach the team” and the correction lands here.</p>')}</div></div>
      <div class="row"><button class="btn ink">Save</button></div></form>`; }))}
    <form class="card pad stack" data-act="submit:create"><h2 style="font-size:18px;font-weight:600">New project</h2>
      <div class="row" style="align-items:flex-end">
        <div class="field" style="flex:2;min-width:180px"><label for="np-n">Name</label><input id="np-n" name="name" required placeholder="Weekly sales report"></div>
        <div class="field" style="flex:1;min-width:110px"><label for="np-k">Key</label><input id="np-k" name="key" required placeholder="SALES" maxlength="10" style="font-family:var(--mono);text-transform:uppercase"></div>
        <button class="btn go">Create</button></div></form></div>`;
  bind($app, {
    save: async (f) => { const d = formData(f); await api('PATCH', `/api/projects/${f.dataset.key}`, { name: d.name, playbook: d.playbook, require_human_review: !!d.require_human_review }); projects = await api('GET', '/api/projects'); toast('Saved. Agents get it with their next task.'); },
    create: async (f) => { await api('POST', '/api/projects', formData(f)); projects = await api('GET', '/api/projects'); viewPlaybook(); },
    rule: async (el) => { await api('PATCH', `/api/rules/${el.dataset.id}`, { active: el.checked }); toast(el.checked ? 'Rule on. Agents get it from now.' : 'Rule off.'); },
  });
}

// ---------- ⌘K: delegate or jump ----------
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
function parseDelegation(text) {
  const [first = '', ...rest] = text.split('\n');
  let member = null; let project = null;
  const title = first.replace(/@([\w'.-]+)/g, (_, w) => {
    const n = norm(w);
    member = members.find((m) => norm(m.name) === n) || members.find((m) => norm(m.name).startsWith(n)) || members.find((m) => norm(m.name).includes(n)) || member;
    return '';
  }).replace(/#([A-Za-z0-9]+)/g, (_, k) => { project = projects.find((p) => p.key === k.toUpperCase()) || project; return ''; }).replace(/\s+/g, ' ').trim();
  const criteria = rest.map((l) => l.replace(/^\s*(?:[-*•]|done when:?)\s*/i, '').trim()).filter(Boolean);
  return { title, member, project, criteria };
}

let palTasks = [];
async function openPalette(prefill = '') {
  const box = $('palette');
  box.hidden = false;
  box.innerHTML = html`<div class="pal" role="dialog" aria-label="Delegate or jump">
    <textarea id="pal-in" rows="1" placeholder="Delegate a task, or jump to one…" aria-label="Delegate or jump"></textarea>
    <div class="hint">Delegate: <code>Webinar follow-up email @claude #MKT</code>, then <kbd>⇧↵</kbd> for each “done when” line. Jump: type a key or a few words.</div>
    <div class="chips" id="pal-chips"></div><div class="opts" id="pal-opts"></div></div>`;
  const input = $('pal-in');
  input.value = prefill;
  input.focus();
  let sel = 0; let opts = [];
  const pages = [['Briefing', '#/'], ['Work map', '#/map'], ['Tasks', '#/tasks'], ['Team', '#/team'], ['Playbook', '#/playbook'], ['Connect an agent', '#/team/connect']];
  const close = () => { box.hidden = true; box.innerHTML = ''; };
  const render = () => {
    const q = input.value;
    const d = parseDelegation(q);
    const ql = q.trim().toLowerCase();
    const defaultProject = d.project || projects[0];
    const chips = $('pal-chips');
    chips.innerHTML = d.title.split(' ').length >= 2 || d.member || d.project
      ? html`<span class="pill ${d.member ? 'on' : ''}">For ${d.member ? d.member.name : 'anyone who picks it up'}</span><span class="pill ${d.project ? 'on' : ''}">In ${defaultProject?.key}</span>${raw(d.criteria.length ? html`<span class="pill on">${plural(d.criteria.length, 'check')}</span>` : '')}`
      : '';
    opts = [];
    if (d.title.length >= 4 && defaultProject) opts.push({ kind: 'delegate', d: { ...d, project: defaultProject } });
    const tasks = ql ? palTasks.filter((t) => t.key.toLowerCase().includes(ql) || t.title.toLowerCase().includes(ql)).slice(0, 6)
      : palTasks.filter((t) => ['review', 'blocked', 'in_progress'].includes(t.status)).slice(0, 5);
    tasks.forEach((t) => opts.push({ kind: 'task', t }));
    pages.filter(([l]) => !ql || l.toLowerCase().includes(ql)).forEach(([l, h]) => opts.push({ kind: 'page', l, h }));
    if (sel >= opts.length) sel = 0;
    let g = '';
    $('pal-opts').innerHTML = opts.map((o, i) => {
      const grp = o.kind === 'delegate' ? 'Delegate' : o.kind === 'task' ? (ql ? 'Tasks' : 'Moving now') : 'Go to';
      const head = grp !== g ? `<div class="grp">${grp}</div>` : ''; g = grp;
      if (o.kind === 'delegate') return head + html`<div class="opt delegate ${i === sel ? 'on' : ''}" data-i="${i}"><span class="ic">+</span><div class="grow"><div class="t">${o.d.title}</div>
        <small>New ${o.d.project.key} task for ${o.d.member ? o.d.member.name : 'anyone'}${o.d.criteria.length ? ', done when: ' + o.d.criteria.join('; ') : ''}</small></div><kbd>↵</kbd></div>`;
      if (o.kind === 'task') return head + html`<div class="opt ${i === sel ? 'on' : ''}" data-i="${i}"><span class="ic">${o.t.key.split('-')[1]}</span><div class="grow"><div class="t">${o.t.title}</div><small>${o.t.key} · ${STATUS[o.t.status]}${o.t.assignee ? ' · ' + o.t.assignee.name : ''}</small></div></div>`;
      return head + html`<div class="opt ${i === sel ? 'on' : ''}" data-i="${i}"><span class="ic">→</span><div class="grow"><div class="t">${o.l}</div></div></div>`;
    }).join('');
    $('pal-opts').querySelectorAll('.opt').forEach((el) => { el.onclick = () => { sel = Number(el.dataset.i); run(); }; });
    input.style.height = 'auto'; input.style.height = Math.min(200, input.scrollHeight) + 'px';
  };
  const run = async () => {
    const o = opts[sel];
    if (!o) return;
    if (o.kind === 'page') { close(); location.hash = o.h; return; }
    if (o.kind === 'task') { close(); location.hash = `#/t/${o.t.key}`; return; }
    try {
      const t = await api('POST', '/api/tasks', { project: o.d.project.key, title: o.d.title, criteria: o.d.criteria, ...(o.d.member ? { assignee: o.d.member.name } : {}) });
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
  try { palTasks = await api('GET', '/api/tasks?limit=300'); if (!members.length) members = await api('GET', '/api/members'); render(); } catch {}
}
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && me) { e.preventDefault(); $('palette').hidden ? openPalette() : ($('palette').hidden = true); return; }
  if (e.key === '/' && !typing() && me && $('palette').hidden) { e.preventDefault(); openPalette(); return; }
  keyHandler?.(e);
});

// ---------- router ----------
async function route() {
  clearInterval(pollTimer);
  keyHandler = null;
  if (!token) return viewGate().catch((e) => toast(e.message));
  if (!me) {
    try {
      [me, projects, members] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/projects'), api('GET', '/api/members')]);
    } catch { return; }
    $('gate').hidden = true;
    $('shell').hidden = false;
  }
  const [, view = '', arg] = (location.hash || '#/').split('/');
  const render = {
    '': viewBriefing, map: viewMap, tasks: () => viewTasks(arg), team: () => viewTeam(arg), playbook: viewPlaybook,
    t: () => viewTask(decodeURIComponent(arg || '')),
  }[view] || viewBriefing;
  if (!$app.innerHTML) $app.innerHTML = '<div class="skel"></div>';
  try { await render(); } catch (e) { toast(e.message); }
  window.scrollTo?.({ top: 0 });
  if (view !== '') api('GET', '/api/inbox').then((r) => { decisionCount = r.count; renderShell(view === 't' ? 'tasks' : view); }).catch(() => {});
  // Refresh quietly while visible, unless someone is typing or the command bar is open.
  if (['', 'map', 'tasks'].includes(view)) {
    pollTimer = setInterval(() => {
      if (document.hidden || typing() || !$('palette').hidden) return;
      render().catch(() => {});
    }, 20000);
  }
}

window.addEventListener('hashchange', route);
route();
