// Remote MCP server (Streamable HTTP, stateless JSON responses). The main door for agents.
import * as core from './core';
import type { Ctx } from './core';
import * as views from './views';
import * as continuous from './continuous';
import * as apps from './apps';

/** The part of the connect-time instructions that is about this agent: continuous mode, when it is on. */
async function continuousNote(c: Ctx) {
  const mine = await core.myContinuous(c).catch(() => null);
  return mine ? continuous.instructionsFor(mine.st, mine.who) : '';
}

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_INFO = { name: 'kunla', version: '0.1.0' };

const key = { type: 'string', description: 'Task key, e.g. MKT-42' };
const session = { type: 'string', description: 'Link to this chat or agent session (e.g. https://claude.ai/chat/..., https://claude.ai/code/session_...), or a reference like "claude --resume <id>", so people can open it from the task later' };
const spend = {
  cost_usd: { type: 'number', description: 'Optional: what this stretch of work cost in USD, if you know it. Counts toward a continuous-mode budget.' },
  tokens: { type: 'number', description: 'Optional: tokens used for this stretch of work, if you know it. Counts toward a continuous-mode budget.' },
};
const links = {
  type: 'array', description: 'Links to the work: PR, doc, artifact, paper, sheet, slides, post, chat, file',
  items: { type: 'object', properties: { url: { type: 'string' }, title: { type: 'string' } }, required: ['url'] },
};

const kind = {
  type: 'string',
  description: "Kind of work. Not only code. Kunla's defaults: code, writing (articles, posts, docs, emails, slides), research (market research, competitors, data analysis), learning (papers, books, courses), discussion (meetings, brainstorms, chats that reach decisions), outreach (marketing, sales, publishing, events), design, operations (planning, admin, hiring, finance), other. A workspace or project can set its own list: whoami and get_task (kinds_here) show it. Left out, Kunla guesses from the title.",
};
const notes = {
  type: 'string',
  description: 'The outcome written out, in Markdown, when it is not (only) a link: the decisions and next steps of a discussion, notes on a paper, research findings with sources, what you learned. Counts as a deliverable.',
};
const repo = { type: 'string', description: "The git remote of the repository you work in (output of git remote get-url origin), if any. Kunla remembers it on the project so mentions like PR #12 or acme/site!12 link to the right GitHub, GitHub Enterprise, GitLab, Gitea or Bitbucket host." };
const notes_title = { type: 'string', description: 'Optional heading for the notes, e.g. "Decisions", "Paper notes", "Findings"' };

type Tool = { name: string; description: string; inputSchema: object; run: (c: Ctx, a: any) => Promise<unknown>; readOnly?: boolean; ui?: string };

export const TOOLS: Tool[] = [
  {
    name: 'whoami', readOnly: true,
    description: 'Your Kunla member profile (person or AI), sponsor, the projects you can see, and the kinds of work the workspace and its projects use. For an agent, since_last_session lists what changed for you since you last called: call it when a session starts.',
    inputSchema: { type: 'object', properties: {} },
    run: (c) => core.whoami(c),
  },
  {
    name: 'next_task', readOnly: true,
    description: "The best next thing for you: your task in progress, then work assigned to you, then reviews waiting on you, then open Ready work in your lane, focused projects first. Returns the full brief, playbook, rules, the team's current focus, and ready-made references. If your sponsor turned on continuous mode, the reply has continuous.go: keep taking tasks while it is true, and stop (with its stop_reason) when it is false.",
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Limit to a project key, e.g. MKT' } } },
    run: (c, a) => core.nextTask(c, a.project).then((r) => r ?? { message: 'Nothing waiting for you. Use log_work to record work you do outside the queue.' }),
  },
  {
    name: 'list_tasks', readOnly: true,
    description: 'Search tasks. Filter by project key, status (inbox, ready, in_progress, blocked, review, done; comma separated), kind of work (e.g. research, learning, discussion; comma separated), assignee ("me" or a name), or text.',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, status: { type: 'string' }, kind: { type: 'string' }, assignee: { type: 'string' }, q: { type: 'string' }, limit: { type: 'number' } } },
    run: (c, a) => core.listTasks(c, a),
  },
  {
    name: 'get_task', readOnly: true,
    description: "One task with its brief, acceptance criteria, the project's playbook and 'apply next time' rules, deliverables and notes, reviews, history, its kind of work with how_to_finish (what to hand in and what approval means) and kinds_here (the kinds this project uses), and how to cite it (commit trailer, branch, doc source line, message line).",
    inputSchema: { type: 'object', properties: { key }, required: ['key'] },
    run: (c, a) => core.taskDetail(c, a.key),
  },
  {
    name: 'claim_task',
    description: "Take a Ready task atomically so nobody else works on it. If someone else already holds it you get an error: skip it and call next_task, never work on it in parallel. For AIs the claim is a lease that lapses after a quiet period; any update renews it. Read handoff in the result: it's where the last holder left off. Returns the full task.",
    inputSchema: { type: 'object', properties: { key, session }, required: ['key'] },
    run: async (c, a) => { await core.claimTask(c, a.key, a.session); return core.taskDetail(c, a.key); },
  },
  {
    name: 'heartbeat',
    description: "Keep your claim on a task alive while you work without other updates. If it fails, the task is no longer yours (your lease lapsed or a person took it over): stop working on it and call next_task.",
    inputSchema: { type: 'object', properties: { key }, required: ['key'] },
    run: (c, a) => core.heartbeat(c, a.key),
  },
  {
    name: 'release_task',
    description: "Let go of a task you hold, with a handoff note on where the work stands (what's done, what's left, where the branch or draft is). The next holder reads it first. With to, it goes to that person or agent; without, it goes back to Ready for anyone. Use it when you stop partway, run out of budget, or someone else is better placed.",
    inputSchema: { type: 'object', required: ['key', 'note'], properties: { key, note: { type: 'string', description: 'Handoff: where the work stands and what to do next' }, to: { type: 'string', description: 'Optional: name of the member to hand it to' }, session } },
    run: async (c, a) => { await core.releaseTask(c, a.key, a); return core.taskDetail(c, a.key); },
  },
  {
    name: 'update_task',
    description: 'Add a progress note, change status, or mark blocked with a question for a person. A blocked question goes to the decision inbox. Status parked puts a task off ("later"): only do that when a person asks, optionally with until.',
    inputSchema: {
      type: 'object', required: ['key'],
      properties: {
        key, note: { type: 'string', description: 'Progress or handoff note' },
        status: { type: 'string', enum: ['ready', 'in_progress', 'done', 'declined', 'parked'] },
        until: { type: 'string', description: 'With status parked: date it comes back (ISO). Omit for someday.' },
        blocked_question: { type: 'string', description: 'What you need answered to continue' },
        blocked_on: { type: 'string', description: 'Who should answer (name); empty means anyone' },
        title: { type: 'string' }, brief: { type: 'string' }, criteria: { type: 'array', items: { type: 'string' } },
        priority: { type: 'number', description: '0 urgent to 3 low' }, kind, session, ...spend,
      },
    },
    run: (c, a) => core.updateTask(c, a.key, a),
  },
  {
    name: 'log_work',
    description: "Record work in one sentence: any work, not only code (a discussion that reached a decision, a paper read, a draft written, research done, a campaign sent). With a task key it adds to that task. Without one it creates a task with its own key, so work started in a chat still lands in the record. Put the outcome in notes and/or deliverables. Use status 'review' to send it for review.",
    inputSchema: {
      type: 'object', required: ['summary'],
      properties: {
        summary: { type: 'string', description: 'What was done, in one or two sentences' },
        task: { type: 'string', description: 'Task key, if the work belongs to one' },
        project: { type: 'string', description: 'Project key for a new task; leave out for workspace-level work' },
        title: { type: 'string' }, kind, deliverables: links, notes, notes_title, session, ...spend,
        status: { type: 'string', enum: ['in_progress', 'review', 'done'], description: "For a new task; default 'done'" },
      },
    },
    run: async (c, a) => { const t = await core.logWork(c, a); return core.taskDetail(c, t.key); },
  },
  {
    name: 'submit_for_review',
    description: 'Hand finished work to a reviewer. Needs a short summary and the work: at least one deliverable link, or notes with the outcome written out (or both).',
    inputSchema: { type: 'object', required: ['key', 'summary'], properties: { key, summary: { type: 'string' }, deliverables: links, notes, notes_title, reviewer: { type: 'string' }, session, ...spend } },
    run: (c, a) => core.submitForReview(c, a.key, a),
  },
  {
    name: 'review_task',
    description: "Approve, or request changes. Say what was wrong, and optionally add a rule to apply next time; rules are sent with every future task in the project.",
    inputSchema: {
      type: 'object', required: ['key', 'verdict'],
      properties: {
        key, verdict: { type: 'string', enum: ['approved', 'changes_requested'] },
        comment: { type: 'string' }, what_was_wrong: { type: 'string' },
        rule: { type: 'string', description: "'Apply next time' rule for this project" },
      },
    },
    run: (c, a) => core.reviewTask(c, a.key, { ...a, via: undefined }),
  },
  {
    name: 'record_decision',
    description: "When the person who sponsors you decides something about a task in your chat (approves it, says merge, sends it back, or answers your question), record it here so it counts in Kunla as their decision, with this chat as the source. Only for your own sponsor's words; never for anyone else, and never on your own judgement. Approving work in Review merges its PR as usual; approving open work marks it done.",
    inputSchema: {
      type: 'object', required: ['key', 'verdict', 'source_url', 'quote'],
      properties: {
        key,
        verdict: { type: 'string', enum: ['approved', 'changes_requested', 'answer'] },
        source_url: { type: 'string', description: 'https link to this chat or thread, where the person decided' },
        quote: { type: 'string', description: "The person's own words, verbatim (e.g. \"Merge\")" },
        comment: { type: 'string' }, what_was_wrong: { type: 'string', description: 'For changes_requested: what the person said needs to change' },
        answer: { type: 'string', description: "For answer: the person's answer to the blocked question" },
      },
    },
    run: (c, a) => core.recordDecision(c, a.key, a),
  },
  {
    name: 'create_task',
    description: "Create a task. Project is optional (leave it out for workspace-level work). To split your work, pass parent with a task key: the sub-task joins the parent's project, and the parent finishes when all sub-tasks do. Tasks from AIs land in the Inbox as proposals unless status is ready. If a similar open task exists you get it back instead; work on that one, or pass force true if it really is different.",
    inputSchema: {
      type: 'object', required: ['title'],
      properties: {
        project: { type: 'string', description: 'Project key, e.g. MKT; leave out for workspace-level work' }, title: { type: 'string' }, brief: { type: 'string', description: 'What to do and why. Write pull requests and issues as full URLs or owner/repo#N (e.g. acme/site#12; acme/site!12 for a GitLab merge request) so they show as links on the task.' },
        criteria: { type: 'array', items: { type: 'string' } }, priority: { type: 'number' },
        assignee: { type: 'string' }, reviewer: { type: 'string' }, parent: { type: 'string', description: 'Parent task key; makes this a sub-task' },
        kind, status: { type: 'string', enum: ['inbox', 'ready'] }, force: { type: 'boolean', description: 'Create even if a similar open task exists' },
      },
    },
    run: async (c, a) => {
      if (!a.force && !a.parent) {
        const similar = await core.similarOpenTasks(c, a.title ?? '', a.project);
        if (similar.length) return { created: false, possible_duplicates: similar, message: 'A similar open task already exists. Work on it (or add a sub-task under it) instead; pass force: true only if this is really different.' };
      }
      return core.createTask(c, a);
    },
  },
  {
    name: 'create_project',
    description: 'Propose a new project (KD-16). From an agent it lands in the decision inbox as a proposal; when a person accepts it, the project is created with this key, name and playbook. Search the projects in whoami first so nobody proposes one twice. A person calling it creates the project at once.',
    inputSchema: {
      type: 'object', required: ['key', 'name'],
      properties: {
        key: { type: 'string', description: 'Task key prefix, 2-10 letters or digits starting with a letter, e.g. DACH' },
        name: { type: 'string' },
        why: { type: 'string', description: 'Why it should be its own project: the goal, and the work that would go in it' },
        playbook: { type: 'string', description: 'Optional playbook for the project, in Markdown' },
      },
    },
    run: (c, a) => core.proposeProject(c, a),
  },
  {
    name: 'decision_inbox', readOnly: true, ui: apps.INBOX_URI,
    description: 'What is waiting on a person: reviews, questions from blocked tasks, proposals, and tasks flagged after repeated review rounds.',
    inputSchema: { type: 'object', properties: {} },
    run: (c) => core.inbox(c),
  },
  {
    name: 'answer_question',
    description: 'Answer a blocked task’s question; the task goes back to its worker.',
    inputSchema: { type: 'object', required: ['key', 'answer'], properties: { key, answer: { type: 'string' } } },
    run: (c, a) => core.answer(c, a.key, a.answer),
  },
  {
    name: 'triage_proposal',
    description: 'Accept a proposal from the Inbox (it becomes Ready) or decline it.',
    inputSchema: { type: 'object', required: ['key', 'accept'], properties: { key, accept: { type: 'boolean' }, note: { type: 'string' } } },
    run: (c, a) => core.triage(c, a.key, a),
  },
  {
    name: 'team_pulse', readOnly: true,
    description: 'What every person and agent is doing right now: working, waiting on a review, blocked, or idle. Use it to avoid duplicate work and to see who is free.',
    inputSchema: { type: 'object', properties: {} },
    run: (c) => views.pulse(c),
  },
  {
    name: 'project_status', readOnly: true, ui: apps.PROGRESS_URI,
    description: 'Project progress: counts by status, who (person or AI) is on what, blockers, recent activity, and the share of updates recorded by agents.',
    inputSchema: { type: 'object', properties: { project: { type: 'string' } } },
    run: (c, a) => core.projectStatus(c, a.project),
  },
];

type Rpc = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: any };

const ok = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id, result });
const err = (id: Rpc['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export const INSTRUCTIONS = `Kunla is the team's record of work, shared by people and AIs.
Working agreement:
1. Before starting, call next_task or get_task; follow the brief, the playbook and every rule. next_task respects the team's focus and your lane, so prefer it over picking work yourself. Both whoami and next_task carry since_last_session: what changed for you since you last called (answers, approvals, work sent back or handed to you, new rules, focus). Act on it before starting new work.
2. Cite the task key in everything you produce (commit trailer, PR title, doc source line, message line); get_task gives the exact text.
3. Record progress with log_work (one sentence). If work has no task yet, log_work creates one.
4. When done, submit_for_review with at least one deliverable link or notes with the outcome. get_task's how_to_finish says what to hand in for that kind of work. If you are stuck, update_task with blocked_question.
5. Split big work into sub-tasks with create_task parent; search before creating so nobody files the same work twice.
6. Pass session (a link to this chat or agent session) when you claim, log work or submit, so people can open the conversation from the task later.
7. A parked task was put off by a person on purpose. Do not resume it, claim it, or ask about it unless the user brings it up.
8. Approved means merge: when a person approves a task whose deliverable is your open PR, squash-merge it once checks pass, unless Kunla already did.
9. Continuous mode: your sponsor can turn it on; whoami, next_task and a line under every reply then say so. When next_task returns continuous.go true, work through tasks one by one: claim, do, submit (or ask with blocked_question), then call next_task again. Being blocked on one task is not a reason to stop; stop only when next_task says go false. Report cost_usd or tokens with log_work or submit_for_review when you know them.
10. When the person who sponsors you decides something about a task in your chat (approve, merge, send back, an answer), call record_decision with their words and a link to the chat, so it counts in Kunla. Never record a decision they didn't make.
11. One holder per task. Claim before you work, and never work on a task someone else holds: if claim_task says it is taken, skip it and call next_task. If heartbeat or an update says the task is no longer yours, stop and move on. When you stop partway, release_task with a handoff note so the next person or agent can carry on; read handoff on a task before you start it.
12. All work counts, not only code. When a chat reaches an outcome (a decision, a takeaway, a draft, findings, notes on a paper, a campaign sent), log_work it yourself with its kind and the outcome in notes or links, without waiting to be asked. Log once per outcome, not every message; keep adding to the same task key as the conversation goes on. Real next steps become their own tasks. Discussion and learning can be logged as done; send work for review when a person must sign it off.
13. Write pull requests and issues as full URLs or owner/repo#N (owner/repo!N for a GitLab merge request) so they show as links, and pass repo (your git remote) when you work in a git repo, so short forms like PR #12 link to the right code host.`;

// Agents working in a git repo pass repo (their remote); the task's project remembers it (KD-42).
for (const t of TOOLS.filter((x) => ['create_task', 'claim_task', 'log_work', 'submit_for_review', 'update_task'].includes(x.name))) {
  (t.inputSchema as any).properties.repo = repo;
  const run = t.run;
  t.run = async (c, a) => {
    const result: any = await run(c, a);
    const k = a?.key ?? a?.task ?? result?.key;
    if (a?.repo && typeof k === 'string') {
      const task = await core.getTask(c, k).catch(() => null);
      if (task) await core.rememberRepo(c, task.project_id, a.repo);
    }
    return result;
  };
}

// Most tools name the task `key`; log_work names it `task`. Accept either, and refuse any other
// unknown argument with the list of real ones, so a misnamed field never silently does something else (KD-47).
const ALIASES: Record<string, string> = { key: 'task', task: 'key' };
export function checkArgs(tool: Tool, args: unknown): Record<string, unknown> | string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return `${tool.name} takes an object of arguments.`;
  const props = Object.keys((tool.inputSchema as any).properties ?? {});
  const out: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (props.includes(k)) out[k] = v;
    else if (ALIASES[k] && props.includes(ALIASES[k]) && !(ALIASES[k] in (args as object))) out[ALIASES[k]] = v;
    else unknown.push(k);
  }
  if (!unknown.length) return out;
  const list = (xs: string[]) => xs.map((x) => `\`${x}\``).join(', ');
  return `${tool.name} doesn't take ${list(unknown)}. Its arguments are: ${props.length ? list(props) : 'none'}. Nothing was changed.`;
}

export async function handleRpc(c: Ctx, msg: Rpc): Promise<object | null> {
  if (msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(msg?.id, -32600, 'Invalid request');
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return ok(msg.id, {
        protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS + await continuousNote(c),
      });
    }
    case 'ping': return ok(msg.id, {});
    case 'tools/list':
      return ok(msg.id, {
        tools: TOOLS.map((t) => ({
          name: t.name, description: t.description, inputSchema: t.inputSchema,
          annotations: { readOnlyHint: !!t.readOnly, destructiveHint: false, openWorldHint: false },
          // Clients with MCP Apps (claude.ai) render this view; others ignore it and show the text (KD-10).
          ...(t.ui ? { _meta: { ui: { resourceUri: t.ui } } } : {}),
        })),
      });
    case 'resources/list': return ok(msg.id, { resources: apps.RESOURCES });
    case 'resources/templates/list': return ok(msg.id, { resourceTemplates: [] });
    case 'resources/read': {
      const r = apps.readResource(msg.params?.uri);
      return r ? ok(msg.id, { contents: [r] }) : err(msg.id, -32002, `Resource not found: ${msg.params?.uri}`);
    }
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return err(msg.id, -32602, `Unknown tool ${msg.params?.name}`);
      const checked = checkArgs(tool, msg.params?.arguments ?? {});
      if (typeof checked === 'string') return ok(msg.id, { content: [{ type: 'text', text: checked }], isError: true });
      try {
        const result = await tool.run(c, checked);
        const nudges = await core.reminders(c);
        const content = [{ type: 'text', text: JSON.stringify(result, null, 2) }];
        if (nudges.length) content.push({ type: 'text', text: 'Reminder: ' + nudges.join(' ') });
        // A continuous agent hears it under every reply (next_task and whoami already say it in full).
        if (!['next_task', 'whoami'].includes(tool.name)) {
          const mine = await core.myContinuous(c);
          if (mine) content.push({ type: 'text', text: continuous.replyLine(mine.st) });
        }
        // A tool with a view also hands it the data as structuredContent, plus who is looking and where the board is.
        const structured = tool.ui && result && typeof result === 'object'
          ? { structuredContent: { ...(result as object), me: { name: c.me.name, kind: c.me.kind }, board: c.baseUrl } } : {};
        return ok(msg.id, { content, ...structured, isError: false });
      } catch (e) {
        if (e instanceof core.KunlaError) return ok(msg.id, { content: [{ type: 'text', text: e.message }], isError: true });
        throw e;
      }
    }
    default:
      if (isNotification) return null; // notifications/initialized etc.
      return err(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}
