// Kunla Worker: REST API, remote MCP server and OAuth for chat connectors, in front of one D1 database.
// The web app is static files in ./public, served by Workers static assets without running this code.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';
import * as core from './core';
import { handleRpc, TOOLS } from './mcp';
import { oauth } from './oauth';
import * as views from './views';

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  LEASE_MINUTES?: string;
  SETUP_TOKEN?: string;
  PUBLIC_URL?: string;
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
  return { db: c.env.DB, me, baseUrl: baseUrl(c), leaseMinutes: Number(c.env.LEASE_MINUTES || 30) };
}

const requireAuth = async (c: C, next: () => Promise<void>) => {
  const ctx = await authenticate(c);
  if (!ctx) return c.json({ error: 'Sign in with a Kunla token (Authorization: Bearer kun_...).' }, 401);
  c.set('ctx', ctx);
  await next();
};

// Bearer tokens only, no cookies, so any origin may call the API: this is what lets one
// person's web app show several workspaces (each its own deployment) side by side.
app.use('/api/*', cors({ origin: '*', allowHeaders: ['authorization', 'content-type'], allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'], maxAge: 86400 }));

// ---------- public ----------
app.get('/api/health', (c) => c.json({ ok: true, name: 'kunla', version: '0.1.0' }));
app.get('/api/setup', async (c) => c.json({ set_up: await core.isSetUp(c.env.DB), needs_setup_token: !!c.env.SETUP_TOKEN }));
app.post('/api/setup', async (c) => {
  const body = await c.req.json<any>();
  if (c.env.SETUP_TOKEN && body.setup_token !== c.env.SETUP_TOKEN) return c.json({ error: 'Wrong setup token.' }, 403);
  return c.json(await core.setup(c.env.DB, body));
});
app.get('/t/:key', (c) => c.redirect(`/app/#/t/${encodeURIComponent(c.req.param('key').toUpperCase())}`));

// ---------- MCP ----------
app.post('/mcp', async (c) => {
  const ctx = await authenticate(c);
  if (!ctx) {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, 401, {
      'WWW-Authenticate': `Bearer resource_metadata="${baseUrl(c)}/.well-known/oauth-protected-resource"`,
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
});
app.get('/mcp', (c) => c.body(null, 405, { Allow: 'POST' }));
app.delete('/mcp', (c) => c.body(null, 405, { Allow: 'POST' }));

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
api.get('/similar', async (c) => c.json(await core.similarOpenTasks(c.env.DB, c.req.query('title') ?? '', c.req.query('project'))));
api.get('/tasks/:key', async (c) => c.json(await core.taskDetail(c.get('ctx'), c.req.param('key'))));
api.patch('/tasks/:key', async (c) => c.json(await core.updateTask(c.get('ctx'), c.req.param('key'), await c.req.json())));
api.post('/tasks/:key/claim', async (c) => c.json(await core.claimTask(c.get('ctx'), c.req.param('key'))));
api.post('/tasks/:key/heartbeat', async (c) => c.json(await core.heartbeat(c.get('ctx'), c.req.param('key'))));
api.post('/tasks/:key/submit', async (c) => c.json(await core.submitForReview(c.get('ctx'), c.req.param('key'), await c.req.json())));
api.post('/tasks/:key/review', async (c) => c.json(await core.reviewTask(c.get('ctx'), c.req.param('key'), await c.req.json())));
api.post('/tasks/:key/triage', async (c) => c.json(await core.triage(c.get('ctx'), c.req.param('key'), await c.req.json())));
api.post('/tasks/:key/answer', async (c) => c.json(await core.answer(c.get('ctx'), c.req.param('key'), (await c.req.json<any>()).answer)));
api.post('/log', async (c) => c.json(await core.logWork(c.get('ctx'), await c.req.json())));

api.get('/members', async (c) => c.json(await core.trackRecord(c.env.DB)));
api.patch('/members/:id', async (c) => c.json(await core.updateMember(c.get('ctx'), c.req.param('id'), await c.req.json())));
api.post('/members/:id/token', async (c) => c.json(await core.rotateToken(c.get('ctx'), c.req.param('id'))));
api.delete('/members/:id', async (c) => c.json(await core.removeMember(c.get('ctx'), c.req.param('id'))));
api.post('/members', async (c) => c.json(await core.addMember(c.get('ctx'), await c.req.json())));
api.get('/projects', async (c) => c.json(await core.listProjects(c.env.DB)));
api.get('/projects/:key', async (c) => c.json(await core.getProject(c.env.DB, c.req.param('key'))));
api.post('/projects', async (c) => c.json(await core.createProject(c.get('ctx'), await c.req.json())));
api.patch('/projects/:key', async (c) => c.json(await core.updateProject(c.get('ctx'), c.req.param('key'), await c.req.json())));
api.get('/rules', async (c) => c.json(await views.rulesWithReach(c.env.DB, c.req.query('project'))));
api.get('/briefing', async (c) => c.json(await views.briefing(c.get('ctx'), Number(c.req.query('hours') || 24))));
api.get('/changes', async (c) => c.json(await views.changes(c.get('ctx'))));
api.get('/progress', async (c) => c.json(await views.progress(c.get('ctx'))));
api.get('/pulse', async (c) => c.json(await views.pulse(c.get('ctx'))));
api.get('/map', async (c) => c.json(await views.workMap(c.get('ctx'), Math.min(14, Number(c.req.query('days') || 5)))));
api.post('/tasks/:key/comment', async (c) => c.json(await core.updateTask(c.get('ctx'), c.req.param('key'), { note: (await c.req.json<any>()).text })));
api.patch('/rules/:id', async (c) => { await core.setRuleActive(c.get('ctx'), c.req.param('id'), !!(await c.req.json<any>()).active); return c.json({ ok: true }); });

app.route('/api', api);

// Anything else falls through to the static web app.
app.all('*', (c) => (c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('Not found', 404)));

export default app;
