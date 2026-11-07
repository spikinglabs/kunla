#!/usr/bin/env node
// Kunla CLI: no dependencies, Node 18+. Used by people, by any command-line agent (kunla run),
// and by the Claude Code plugin's hooks so the record stays up to date without anyone asking.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'kunla');
const CONFIG = join(CONFIG_DIR, 'config.json');
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const git = (...args) => { try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
// A repo can say which workspace and project it belongs to with a .kunla file at its root:
//   {"url": "https://startup.kunla.example", "project": "WEB"}
// so Claude Code in that repo talks to the right workspace and gets work from the right project.
const repoFile = () => { const top = git('rev-parse', '--show-toplevel'); return (top && readJson(join(top, '.kunla'))) || {}; };
const trim = (u) => (u || '').replace(/\/$/, '');
const cfg = () => {
  const file = readJson(CONFIG) || {};
  const url = trim(process.env.KUNLA_URL || repoFile().url || file.url);
  // One token per workspace; never send one workspace's token to another.
  const token = process.env.KUNLA_TOKEN || file.workspaces?.[url] || (url === trim(file.url) ? file.token : '') || '';
  return { url, token };
};
const repoProject = () => process.env.KUNLA_PROJECT || repoFile().project || undefined;
const gitDir = () => { const d = git('rev-parse', '--absolute-git-dir'); return d || null; };

async function api(method, path, body) {
  const { url, token } = cfg();
  if (!url || !token) throw new Error('Not connected. Run: kunla login <url> <token>  (or set KUNLA_URL and KUNLA_TOKEN)');
  const res = await fetch(url + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.KUNLA_TIMEOUT_MS || 8000)),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
// The chat or agent session doing the work, so the task can link back to it. KUNLA_SESSION wins;
// a Claude Code cloud session has a claude.ai link; a local one can be reopened with claude --resume.
function sessionRef() {
  const e = process.env;
  if (e.KUNLA_SESSION) return e.KUNLA_SESSION;
  if (e.CLAUDE_CODE_REMOTE_SESSION_ID) return `https://claude.ai/code/session_${e.CLAUDE_CODE_REMOTE_SESSION_ID.replace(/^cse_/, '')}`;
  if (e.CLAUDE_CODE_SESSION_ID) return `claude --resume ${e.CLAUDE_CODE_SESSION_ID}`;
  return undefined;
}
const WITH_SESSION = new Set(['claim_task', 'log_work', 'submit_for_review', 'update_task']);
const tool = async (name, args = {}) => {
  const session = WITH_SESSION.has(name) && !args.session ? sessionRef() : undefined;
  const r = await api('POST', `/api/tools/${name}`, session ? { ...args, session } : args);
  for (const line of r.reminders || []) console.error(`kunla: ${line}`);
  return r.result;
};

// ---------- current task ----------
// A repo can pin its task in .git/kunla-task; otherwise it is my most recent task in progress.
function pinnedTask() {
  if (process.env.KUNLA_TASK) return process.env.KUNLA_TASK.toUpperCase();
  const d = gitDir();
  if (d && existsSync(join(d, 'kunla-task'))) return readFileSync(join(d, 'kunla-task'), 'utf8').trim() || null;
  return null;
}
function pin(key) {
  const d = gitDir();
  if (d) writeFileSync(join(d, 'kunla-task'), key ? key + '\n' : '');
}
async function currentTask() {
  const pinned = pinnedTask();
  if (pinned) return pinned;
  const mine = await tool('list_tasks', { assignee: 'me', status: 'in_progress', limit: 1 });
  return mine[0]?.key ?? null;
}

// ---------- formatting ----------
function briefText(t, { agreement = true } = {}) {
  const lines = [
    `# Kunla task ${t.key}: ${t.title}`,
    `${t.project ? `Project: ${t.project.name} (${t.project.key})` : `Workspace: ${t.workspace?.name ?? ''} (no project)`}${t.parent ? ` · Sub-task of ${t.parent.key} ${t.parent.title}` : ''} · Status: ${t.status} · Link: ${t.references.link}`,
    '', '## Brief', t.brief || '(no brief)',
  ];
  if (t.criteria?.length) lines.push('', '## Acceptance criteria', ...t.criteria.map((c) => `- ${c}`));
  if (t.rules?.length) lines.push('', '## Rules (from earlier reviews; always follow)', ...t.rules.map((r) => `- ${r.text}`));
  const changes = (t.reviews || []).filter((r) => r.verdict === 'changes_requested').slice(-1)[0];
  if (changes && t.status === 'in_progress') lines.push('', `## Changes requested by ${changes.reviewer}`, [changes.comment, changes.what_was_wrong].filter(Boolean).join('\n'));
  if (t.blocked_question) lines.push('', `## Blocked on`, t.blocked_question);
  if (t.playbook?.trim()) lines.push('', '## Playbook', t.playbook.trim());
  lines.push('', '## How to cite this task',
    `- Commit trailer: ${t.references.commit_trailer} (added automatically by the git hook)`,
    `- Branch: ${t.references.branch} · PR title: ${t.references.pr_title}`,
    `- Docs: ${t.references.doc_source_line}`);
  if (agreement) lines.push('', '## Working agreement',
    '- Log progress with the Kunla log_work tool in one sentence when you finish a meaningful step.',
    '- When done, call submit_for_review with a summary and at least one deliverable link (PR, doc, paper, file) or notes with the outcome.',
    '- If you need a decision from a person, call update_task with blocked_question instead of guessing.');
  return lines.join('\n');
}

function remoteWebUrl() {
  let u = git('remote', 'get-url', 'origin');
  if (!u) return null;
  u = u.replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '');
  return /^https:\/\//.test(u) ? u.replace(/\/\/[^@/]+@/, '//') : null;
}

/** Log commits made since the last sync that carry a Task: trailer. Progress from what agents do. */
// Renew the claim only when it is within 10 minutes of lapsing, so a busy session costs a
// request every 20 minutes or so instead of one per prompt.
async function keepAlive(key) {
  const d = gitDir();
  const f = d ? join(d, 'kunla-lease') : null;
  const cached = f && existsSync(f) ? readFileSync(f, 'utf8').trim().split(' ') : [];
  if (cached[0] === key && cached[1] && new Date(cached[1]).getTime() - Date.now() > 10 * 60_000) return;
  const r = await tool('heartbeat', { key }).catch(() => null);
  if (f && r?.lease_expires_at) writeFileSync(f, `${key} ${r.lease_expires_at}\n`);
}

async function syncCommits() {
  const d = gitDir();
  if (!d) return [];
  const markFile = join(d, 'kunla-last-commit');
  const head = git('rev-parse', 'HEAD');
  if (!head) return [];
  const last = existsSync(markFile) ? readFileSync(markFile, 'utf8').trim() : '';
  const range = last && git('cat-file', '-t', last) === 'commit' ? `${last}..HEAD` : '-20';
  const log = git('log', range, '--format=%H%x1f%s%x1f%(trailers:key=Task,valueonly,separator=%x20)%x1e');
  writeFileSync(markFile, head + '\n');
  if (!log) return [];
  const web = remoteWebUrl();
  const byTask = new Map();
  for (const rec of log.split('\x1e').map((s) => s.trim()).filter(Boolean)) {
    const [sha, subject, trailer] = rec.split('\x1f');
    const key = (trailer || '').trim().split(/\s+/)[0]?.toUpperCase();
    if (!key || !/^[A-Z][A-Z0-9]+-\d+$/.test(key)) continue;
    if (!byTask.has(key)) byTask.set(key, []);
    byTask.get(key).push({ sha, subject, url: web && /github|gitlab/.test(web) ? `${web}/commit/${sha}` : null });
  }
  const done = [];
  for (const [key, commits] of byTask) {
    const summary = commits.length === 1 ? `Commit: ${commits[0].subject}` : `${commits.length} commits: ${commits.map((c) => c.subject).join('; ')}`;
    await tool('log_work', { task: key, summary: summary.slice(0, 500), deliverables: commits.filter((c) => c.url).map((c) => ({ url: c.url, title: c.sha.slice(0, 7) + ' ' + c.subject })) });
    done.push(key);
  }
  return done;
}

function installGitHook({ quiet } = {}) {
  const d = gitDir();
  if (!d) { if (!quiet) console.error('Not in a git repository.'); return false; }
  const hooksPath = git('config', 'core.hooksPath');
  const dir = hooksPath ? join(dirname(d), hooksPath) : join(d, 'hooks');
  const file = join(dir, 'commit-msg');
  const self = new URL(import.meta.url).pathname;
  if (existsSync(file)) {
    const cur = readFileSync(file, 'utf8');
    if (cur.includes('kunla')) return true;
    if (!quiet) console.error(`A commit-msg hook already exists at ${file}. Add this line to it:\n  node "${self}" hook commit-msg "$1" || true`);
    return false;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `#!/bin/sh\n# Added by Kunla: adds the Task: trailer for the current task.\nnode "${self}" hook commit-msg "$1" || true\n`);
  chmodSync(file, 0o755);
  if (!quiet) console.log(`Installed ${file}`);
  return true;
}

function readStdin() {
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function lastAssistantText(transcriptPath) {
  try {
    const lines = readFileSync(transcriptPath, 'utf8').trim().split('\n').reverse();
    for (const l of lines) {
      const e = JSON.parse(l);
      const msg = e.message;
      if (e.type === 'assistant' && msg?.content) {
        const text = (Array.isArray(msg.content) ? msg.content : [msg.content]).map((c) => (typeof c === 'string' ? c : c.text || '')).join(' ').trim();
        if (text) return text;
      }
    }
  } catch {}
  return null;
}

// ---------- hooks (always exit 0 and stay quiet on failure: never block the agent) ----------
const hooks = {
  async 'session-start'() {
    if (!cfg().url || !cfg().token) return;
    if (process.env.KUNLA_GIT_HOOK !== '0') installGitHook({ quiet: true });
    await syncCommits().catch(() => {});
    const key = await currentTask();
    if (key) {
      await tool('claim_task', { key }).catch(() => {});
      const t = await tool('get_task', { key });
      console.log(`You are working on Kunla task ${t.key}. Its brief, rules and playbook follow; follow them.\n\n${briefText(t)}`);
      return;
    }
    const next = await tool('next_task', { project: repoProject() });
    const me = await tool('whoami', {});
    const focus = me.projects.filter((p) => p.focus).map((p) => `${p.key} ${p.name}`);
    console.log([
      `Kunla is connected: you are "${me.name}", an AI member of ${me.workspace?.name ?? 'the team'}'s record of work (${me.board}).`,
      focus.length ? `The team's focus right now: ${focus.join(', ')}.` : '',
      repoProject() ? `This repo belongs to project ${repoProject()}; file new tasks there.` : '',
      next?.task ? `Next task waiting for you: ${next.task.key} "${next.task.title}" (${next.reason}). If the user wants it, call claim_task and follow its brief.` : 'No task is waiting for you.',
      next?.continuous?.go ? 'Continuous mode is on for you: work through tasks one by one (claim, do, submit, then next_task again) until next_task says stop.' : '',
      'If the user asks for work that has no task, call log_work when you finish it so it lands in the record with a key.',
      'If the work belongs to a task, claim it with claim_task first; the commit hook will then cite it automatically.',
    ].filter(Boolean).join('\n'));
  },
  async prompt() {
    const key = await currentTask();
    if (key) await keepAlive(key);
  },
  async stop() {
    const input = readStdin();
    if (input.stop_hook_active) return;
    await syncCommits();
    const key = await currentTask();
    if (key) await keepAlive(key);
  },
  async 'session-end'() {
    const input = readStdin();
    await syncCommits();
    const key = pinnedTask() || (await currentTask());
    if (!key) return;
    const text = input.transcript_path ? lastAssistantText(input.transcript_path) : null;
    await tool('log_work', { task: key, summary: `Session ended${text ? ': ' + text.replace(/\s+/g, ' ').slice(0, 400) : '.'}` });
  },
  async 'commit-msg'(file) {
    if (!file) return;
    const msg = readFileSync(file, 'utf8');
    if (/^Task:\s/m.test(msg)) return;
    const key = await currentTask();
    if (!key) return;
    const link = `${cfg().url}/t/${key}`;
    writeFileSync(file, msg.replace(/\s*$/, '') + `\n\nTask: ${key} ${link}\n`);
  },
};

// ---------- commands ----------
/** --notes "text" or --notes @path/to/notes.md */
function notesArg(v) {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  return v.startsWith('@') ? readFileSync(v.slice(1), 'utf8') : v;
}

function flags(argv) {
  const out = { _: [], link: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out.rest = argv.slice(i + 1); break; }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      if (k === 'link') out.link.push(v); else out[k] = v;
    } else out._.push(a);
  }
  return out;
}

const HELP = `kunla: the team's record of work, from the command line.

  kunla login <url> <token>        Save your connection (~/.config/kunla/config.json)
  kunla whoami                     Who you are in Kunla
  kunla init [PROJECT]             Tie this repo to the current workspace (and a project) with a .kunla file
  kunla next [--project P]         The best next task for you
  kunla use <KEY>                  Claim a task and pin it to this repo
  kunla show [KEY]                 The brief, rules and history
  kunla log "<summary>" [--task KEY] [--link URL]... [--kind K] [--notes TEXT|@file] [--review]
                                   Record any work, not only code (creates a task if there is none)
                                   K: code, writing, research, reading, learning, discussion, marketing, sales, data, design
  kunla submit "<summary>" (--link URL | --notes TEXT|@file) [--task KEY]
  kunla block "<question>" [--task KEY]
  kunla status [PROJECT]           Project progress
  kunla release                    Unpin the current task from this repo
  kunla install-git-hook           Add Task: trailers to commits automatically
  kunla run <KEY> [--no-prompt] -- <agent command...>
                                   Start any agent on a task (e.g. kunla run MKT-42 -- codex)
  kunla hook <session-start|prompt|stop|session-end|commit-msg>   (used by agent plugins)`;

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const f = flags(argv);
  switch (cmd) {
    case 'login': {
      const [url, token] = f._;
      if (!url || !token) throw new Error('Usage: kunla login <url> <token>');
      mkdirSync(CONFIG_DIR, { recursive: true });
      const prev = readJson(CONFIG) || {};
      const workspaces = { ...(prev.workspaces || {}), ...(prev.url && prev.token ? { [trim(prev.url)]: prev.token } : {}), [trim(url)]: token };
      writeFileSync(CONFIG, JSON.stringify({ url: trim(url), token, workspaces }, null, 2), { mode: 0o600 });
      const me = await tool('whoami');
      console.log(`Connected to ${url} as ${me.name} (${me.kind}).`);
      return;
    }
    case 'whoami': { const me = await tool('whoami'); console.log(`${me.name} (${me.kind}${me.sponsor ? `, sponsored by ${me.sponsor}` : ''}) in ${me.workspace?.name}\nProjects: ${me.projects.map((p) => p.key + (p.focus ? '*' : '')).join(', ')}${me.lane?.length ? `\nLane: ${me.lane.join(', ')}` : ''}\nBoard: ${me.board}`); return; }
    case 'init': {
      const top = git('rev-parse', '--show-toplevel');
      if (!top) throw new Error('Run kunla init inside a git repo.');
      const data = { url: cfg().url, ...(f._[0] ? { project: f._[0].toUpperCase() } : {}) };
      writeFileSync(join(top, '.kunla'), JSON.stringify(data, null, 2) + '\n');
      console.log(`Wrote ${join(top, '.kunla')}: this repo now talks to ${data.url}${data.project ? ` and works on ${data.project}` : ''}. Commit it so teammates and agents share it.`);
      return;
    }
    case 'next': {
      const n = await tool('next_task', { project: f.project || repoProject() });
      if (!n?.task) return console.log(n?.continuous?.message || 'Nothing waiting for you.');
      console.log(`${n.task.key}  ${n.task.title}  (${n.reason})\n${n.task.references.link}`);
      return;
    }
    case 'use': {
      const key = (f._[0] || '').toUpperCase();
      if (!key) throw new Error('Usage: kunla use <KEY>');
      await tool('claim_task', { key });
      pin(key);
      console.log(`Working on ${key}. Commits in this repo will cite it.`);
      return;
    }
    case 'release': pin(null); console.log('Unpinned.'); return;
    case 'show': {
      const key = f._[0] || (await currentTask());
      if (!key) throw new Error('No current task. Pass a key.');
      console.log(briefText(await tool('get_task', { key }), { agreement: false }));
      return;
    }
    case 'log': {
      const summary = f._.join(' ');
      const task = f.task || pinnedTask() || undefined;
      const t = await tool('log_work', { summary, task, project: f.project || (task ? undefined : repoProject()), deliverables: f.link.map((url) => ({ url })),
        kind: typeof f.kind === 'string' ? f.kind : undefined, notes: notesArg(f.notes), status: f.review ? 'review' : undefined });
      console.log(`Logged on ${t.key}: ${t.references.link}`);
      return;
    }
    case 'submit': {
      const key = f.task || (await currentTask());
      if (!key) throw new Error('No current task. Use --task KEY.');
      const notes = notesArg(f.notes);
      if (!f.link.length && !notes) throw new Error('Add at least one --link to the work, or --notes with the outcome.');
      await tool('submit_for_review', { key, summary: f._.join(' '), deliverables: f.link.map((url) => ({ url })), notes });
      if (pinnedTask() === key) pin(null);
      console.log(`${key} is in review.`);
      return;
    }
    case 'block': {
      const key = f.task || (await currentTask());
      if (!key) throw new Error('No current task. Use --task KEY.');
      await tool('update_task', { key, blocked_question: f._.join(' ') });
      console.log(`${key} is blocked; the question is in the decision inbox.`);
      return;
    }
    case 'status': {
      const s = await tool('project_status', { project: f._[0] });
      const c = s.counts;
      console.log(`${s.project ? s.project.name : 'All projects'}: ${c.done} done, ${c.review} in review, ${c.in_progress} in progress, ${c.blocked} blocked, ${c.ready + c.inbox} waiting`);
      for (const w of s.who_is_on_what) console.log(`  ${w.member.name}: ${w.tasks.map((t) => `${t.key} (${t.status})`).join(', ')}`);
      for (const b of s.blocked) console.log(`  Blocked ${b.key}: ${b.question}`);
      console.log(s.link);
      return;
    }
    case 'install-git-hook': installGitHook(); return;
    case 'run': {
      const key = (f._[0] || '').toUpperCase();
      if (!key || !f.rest?.length) throw new Error('Usage: kunla run <KEY> -- <agent command...>');
      await tool('claim_task', { key });
      pin(key);
      installGitHook({ quiet: true });
      const t = await tool('get_task', { key });
      const args = [...f.rest.slice(1)];
      if (!f['no-prompt']) args.push(briefText(t));
      console.error(`kunla: starting ${f.rest[0]} on ${key}`);
      const timer = setInterval(() => tool('heartbeat', { key }).catch(() => {}), 10 * 60_000);
      const code = await new Promise((resolve) => {
        const child = spawn(f.rest[0], args, { stdio: 'inherit', env: { ...process.env, KUNLA_TASK: key } });
        child.on('exit', (c) => resolve(c ?? 1));
        child.on('error', (e) => { console.error(e.message); resolve(1); });
      });
      clearInterval(timer);
      const synced = await syncCommits().catch(() => []);
      await tool('log_work', { task: key, summary: `${f.rest[0]} session ended (exit ${code})${synced.length ? '; commits recorded' : ''}.` }).catch(() => {});
      console.error(`kunla: recorded on ${key}. When the work is ready: kunla submit "<summary>" --link <url>`);
      process.exitCode = code;
      return;
    }
    case 'hook': {
      const h = hooks[f._[0]];
      if (!h) throw new Error(`Unknown hook ${f._[0]}`);
      try { await h(f._[1]); } catch (e) { if (process.env.KUNLA_DEBUG) console.error(`kunla hook: ${e.message}`); }
      return;
    }
    default:
      console.log(HELP);
  }
}

main().catch((e) => { console.error(`kunla: ${e.message}`); process.exitCode = 1; });
