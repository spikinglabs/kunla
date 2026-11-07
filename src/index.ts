// Kunla Worker: REST API, remote MCP server and OAuth for chat connectors, in front of one D1 database.
// The web app is static files in ./public, served by Workers static assets without running this code.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';
import * as core from './core';
import { handleRpc, TOOLS } from './mcp';
import { oauth } from './oauth';
import * as views from './views';
import * as github from './github';
import * as wake from './wake';
import * as merge from './merge';
import * as continuous from './continuous';

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  LEASE_MINUTES?: string;
  SETUP_TOKEN?: string;
  PUBLIC_URL?: string;
  GITHUB_WEBHOOK_SECRET?: string; // optional; admins can also create the secret in the app
  GITHUB_TOKEN?: string;          // optional; lets "approve" merge PRs (admins can also store one in the app)
}
type Vars = { ctx: core.Ctx };
type C = Context<{ Bindings: Env; Variables: Vars }>;

export const baseUrl = (c: Context<any>) => (c.env.PUBLIC_URL || new URL(c.req.url).origin).replace(/\/$/, '');

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.onError((e, c) => {
  if (e instanceof core.KunlaError) return c.json({ error: e.message }, e.status as any);
  console.error(e);
  return c.json({ error: 'Something went wrong on the server.' }, 500);
});

// ---------- auth ----------
async function authenticate(c: C): Promise<core.Ctx | null> {
  const h = c.req.header('authorization') ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) return null;
  const me = await core.memberForToken(c.env.DB, token);
  if (!me) return null;
  // The token decides the workspace: every read and write below is limited to it.
  return { db: c.env.DB, me, space: me.space_id, baseUrl: baseUrl(c), leaseMinutes: Number(c.env.LEASE_MINUTES || 30), notify: (w) => sendLater(c, wake.deliver(c.env.DB, w)),
    defer: (job) => sendLater(c, job()), githubToken: c.env.GITHUB_TOKEN };
}

// Wake-up calls go out after the response, so a person's click never waits on an agent's server.
function sendLater(c: Context<any>, p: Promise<unknown>) {
  const safe = p.catch((e) => console.error('wake failed', e));
  try { c.executionCtx.waitUntil(safe); } catch { /* no execution context (tests, local scripts): the promise still runs */ }
}

const requireAuth = async (c: C, next: () => Promise<void>) => {
  const ctx = await authenticate(c);
  if (!ctx) return c.json({ error: 'Sign in with a Kunla token (Authorization: Bearer kun_...).' }, 401);
  c.set('ctx', ctx);
  await next();
};

// Bearer tokens only, no cookies, so any origin may call the API: this is what lets one
// person's web app show several workspaces side by side, here or on other deployments.
app.use('/api/*', cors({ origin: '*', allowHeaders: ['authorization', 'content-type'], allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], maxAge: 86400 }));

// ---------- public ----------
app.get('/api/health', (c) => c.json({ ok: true, name: 'kunla', version: '0.1.0' }));
app.get('/api/setup', async (c) => c.json({ set_up: await core.isSetUp(c.env.DB), needs_setup_token: !!c.env.SETUP_TOKEN }));
app.post('/api/setup', async (c) => {
  const body = await c.req.json<any>();
  if (c.env.SETUP_TOKEN && body.setup_token !== c.env.SETUP_TOKEN) return c.json({ error: 'Wrong setup token.' }, 403);
  return c.json(await core.setup(c.env.DB, body));
});
// GitHub calls this when a pull request or push happens; tasks cited by key update themselves.
app.post('/hooks/github', async (c) => {
  const ctx: core.Ctx = { db: c.env.DB, me: null as any, space: '', baseUrl: baseUrl(c), leaseMinutes: Number(c.env.LEASE_MINUTES || 30),
    notify: (w) => sendLater(c, wake.deliver(c.env.DB, w)), githubToken: c.env.GITHUB_TOKEN };
  const r = await github.handleWebhook(ctx, c.req.raw, c.env.GITHUB_WEBHOOK_SECRET);
  return c.json(r.body, r.status as any);
});
app.get('/t/:key', (c) => c.redirect(`/app/#/t/${encodeURIComponent(c.req.param('key').toUpperCase())}`));

// ---------- MCP ----------
// /mcp takes a token from any workspace. /mcp/<KEY> is the same server for one workspace only, so a
// chat app that allows one connector per URL (claude.ai) can add one connector per workspace: OAuth on
// that address signs in to that workspace, and a token from another workspace is turned away.
async function handleMcp(c: C, wsKey?: string) {
  const ctx = await authenticate(c);
  const space = wsKey ? await core.workspaceByKey(c.env.DB, wsKey) : null;
  if (wsKey && !space) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32004, message: `No workspace ${wsKey.toUpperCase()} on this Kunla.` } }, 404);
  if (!ctx || (space && ctx.space !== space.id)) {
    const meta = `${baseUrl(c)}/.well-known/oauth-protected-resource${space ? `/mcp/${space.key}` : ''}`;
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: ctx ? `This token belongs to another workspace; connect to ${space!.name} again.` : 'Unauthorized' } }, 401, {
      'WWW-Authenticate': `Bearer resource_metadata="${meta}"`,
    });
  }
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleRpc(ctx, m)))).filter(Boolean);
    return out.length ? c.json(out) : c.body(null, 202);
  }
  const res = await handleRpc(ctx, body);
  return res ? c.json(res) : c.body(null, 202);
}
app.post('/mcp', (c) => handleMcp(c));
app.post('/mcp/:ws', (c) => handleMcp(c, c.req.param('ws')));
for (const path of ['/mcp', '/mcp/:ws']) {
  app.get(path, (c) => c.body(null, 405, { Allow: 'POST' }));
  app.delete(path, (c) => c.body(null, 405, { Allow: 'POST' }));
}

app.route('/', oauth);

// ---------- REST (web app and CLI) ----------
const api = new Hono<{ Bindings: Env; Variables: Vars }>();
api.use('*', requireAuth);

// Every MCP tool is also a REST call: POST /api/tools/<name> with the same arguments.
api.post('/tools/:name', async (c) => {
  const tool = TOOLS.find((t) => t.name === c.req.param('name'));
  if (!tool) return c.json({ error: 'Unknown tool' }, 404);
  const ctx = c.get('ctx');
  const result = await tool.run(ctx, await c.req.json().catch(() => ({})));
  return c.json({ result, reminders: await core.reminders(ctx) });
});

api.get('/me', async (c) => c.json(await core.whoami(c.get('ctx'))));
api.get('/inbox', async (c) => c.json(await core.inbox(c.get('ctx'))));
api.get('/next', async (c) => c.json(await core.nextTask(c.get('ctx'), c.req.query('project'))));
api.get('/status', async (c) => c.json(await core.projectStatus(c.get('ctx'), c.req.query('project'))));
api.get('/tasks', async (c) => c.json(await core.listTasks(c.get('ctx'), c.req.query() as any)));
api.post('/tasks', async (c) => c.json(await core.createTask(c.get('ctx'), await c.req.json())));
api.get('/similar', async (c) => c.json(await core.similarOpenTasks(c.get('ctx'), c.req.query('title') ?? '', c.req.query('project'))));
api.get('/tasks/:key', async (c) => c.json(await core.taskDetail(c.get('ctx'), c.req.param('key'))));
api.patch('/tasks/:key', async (c) => c.json(await core.updateTask(c.get('ctx'), c.req.param('key'), await c.req.json())));
api.post('/tasks/:key/claim', async (c) => c.json(await core.claimTask(c.get('ctx'), c.req.param('key'), (await c.req.json<any>().catch(() => ({})))?.session)));
api.post('/tasks/:key/heartbeat', async (c) => c.json(await core.heartbeat(c.get('ctx'), c.req.param('key'))));
api.post('/tasks/:key/submit', async (c) => c.json(await core.submitForReview(c.get('ctx'), c.req.param('key'), await c.req.json())));
api.post('/tasks/:key/review', async (c) => c.json(await core.reviewTask(c.get('ctx'), c.req.param('key'), { ...(await c.req.json<any>()), via: undefined })));
// An agent records a decision its sponsor made in a chat; the person can undo it from the task.
api.post('/tasks/:key/decision', async (c) => c.json(await core.recordDecision(c.get('ctx'), c.req.param('key'), await c.req.json())));
api.post('/tasks/:key/decision/undo', async (c) => c.json(await core.undoDecision(c.get('ctx'), c.req.param('key'))));
api.post('/tasks/:key/triage', async (c) => c.json(await core.triage(c.get('ctx'), c.req.param('key'), await c.req.json())));
api.post('/tasks/:key/answer', async (c) => c.json(await core.answer(c.get('ctx'), c.req.param('key'), (await c.req.json<any>()).answer)));
api.post('/tasks/:key/park', async (c) => c.json(await core.parkTask(c.get('ctx'), c.req.param('key'), await c.req.json().catch(() => ({})))));
api.post('/tasks/:key/unpark', async (c) => c.json(await core.unparkTask(c.get('ctx'), c.req.param('key'))));
api.post('/log', async (c) => c.json(await core.logWork(c.get('ctx'), await c.req.json())));

api.get('/members', async (c) => c.json(await core.trackRecord(c.get('ctx'))));
api.patch('/members/:id', async (c) => c.json(await core.updateMember(c.get('ctx'), c.req.param('id'), await c.req.json())));
api.put('/members/:id/wake', async (c) => c.json(await core.setCallback(c.get('ctx'), c.req.param('id'), await c.req.json())));
api.delete('/members/:id/wake', async (c) => c.json(await core.setCallback(c.get('ctx'), c.req.param('id'), null)));
api.post('/members/:id/wake/test', async (c) => {
  const ctx = c.get('ctx');
  const m = await core.getMember(ctx, c.req.param('id'));
  if (ctx.me.kind !== 'human' || !(ctx.me.roles.includes('admin') || m.sponsor_id === ctx.me.id)) return c.json({ error: "Only the agent's sponsor or an admin can test its wake-up URL." }, 403);
  const cb = wake.parseCallback(m.callback);
  if (!cb) return c.json({ error: `${m.name} has no wake-up URL yet.` }, 400);
  return c.json(await wake.deliver(c.env.DB, { member: { id: m.id, name: m.name }, callback: cb, event: 'ping', task: null, note: null, by: ctx.me.name, baseUrl: ctx.baseUrl }));
});
api.put('/members/:id/continuous', async (c) => c.json(await core.setContinuous(c.get('ctx'), c.req.param('id'), await c.req.json())));
api.post('/members/:id/token', async (c) => c.json(await core.rotateToken(c.get('ctx'), c.req.param('id'))));
api.delete('/members/:id', async (c) => c.json(await core.removeMember(c.get('ctx'), c.req.param('id'))));
api.post('/workspaces', async (c) => c.json(await core.createWorkspace(c.get('ctx'), await c.req.json())));
api.post('/members', async (c) => c.json(await core.addMember(c.get('ctx'), await c.req.json())));
api.get('/projects', async (c) => c.json(await core.listProjects(c.get('ctx'))));
api.get('/projects/:key', async (c) => c.json(await core.getProject(c.get('ctx'), c.req.param('key'))));
api.post('/projects', async (c) => c.json(await core.createProject(c.get('ctx'), await c.req.json())));
api.patch('/projects/:key', async (c) => c.json(await core.updateProject(c.get('ctx'), c.req.param('key'), await c.req.json())));
api.get('/rules', async (c) => c.json(await views.rulesWithReach(c.get('ctx'), c.req.query('project'))));
api.get('/briefing', async (c) => c.json(await views.briefing(c.get('ctx'), Number(c.req.query('hours') || 24))));
api.get('/changes', async (c) => c.json(await views.changes(c.get('ctx'))));
api.get('/progress', async (c) => c.json(await views.progress(c.get('ctx'))));
api.get('/pulse', async (c) => c.json(await views.pulse(c.get('ctx'))));
api.get('/map', async (c) => c.json(await views.workMap(c.get('ctx'), Math.min(14, Math.max(0.25, Number(c.req.query('days')) || 5)))));
api.post('/tasks/:key/comment', async (c) => c.json(await core.updateTask(c.get('ctx'), c.req.param('key'), { note: (await c.req.json<any>()).text })));
api.patch('/rules/:id', async (c) => { await core.setRuleActive(c.get('ctx'), c.req.param('id'), !!(await c.req.json<any>()).active); return c.json({ ok: true }); });

api.get('/integrations/github', async (c) => c.json(await github.connectionInfo(c.get('ctx'), c.env.GITHUB_WEBHOOK_SECRET)));
api.post('/integrations/github', async (c) => c.json(await github.rotateSecret(c.get('ctx'), c.env.GITHUB_WEBHOOK_SECRET)));
api.put('/integrations/github/token', async (c) => c.json(await merge.setToken(c.get('ctx'), (await c.req.json<any>()).token ?? null)));
// The PR behind a task in Review, with its checks, so the review card can say "Approve and merge PR #N".
api.get('/tasks/:key/pr', async (c) => {
  const ctx = c.get('ctx');
  const t = await core.getTask(ctx, c.req.param('key'));
  const pr = await merge.taskPr(c.env.DB, t.id);
  if (!pr) return c.json({ pr: null });
  const token = await merge.getToken(ctx);
  if (!token) return c.json({ pr, merge_by: 'agent' });
  try { return c.json({ pr, merge_by: 'kunla', ...(await merge.prState(token, pr)) }); }
  catch (e) { return c.json({ pr, merge_by: 'kunla', error: (e as Error).message }); }
});

app.route('/api', api);

// Anything else falls through to the static web app.
app.all('*', (c) => (c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('Not found', 404)));

// Cron (wrangler.toml [triggers]): at the start of each UTC day, wake continuous agents that stopped on a daily budget.
export async function scheduled(_e: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
  const base = (env.PUBLIC_URL || '').replace(/\/$/, '');
  const jobs: Promise<unknown>[] = [];
  await continuous.newDay({ db: env.DB, baseUrl: base, leaseMinutes: Number(env.LEASE_MINUTES || 30), notify: (w) => { jobs.push(wake.deliver(env.DB, w).catch((e) => console.error('wake failed', e))); } });
  ctx.waitUntil(Promise.all(jobs));
}

export default { fetch: app.fetch, scheduled };
