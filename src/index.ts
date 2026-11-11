// Kunla Worker: REST API, remote MCP server and OAuth for chat connectors, in front of one D1 database.
// The web app is static files in ./public, served by Workers static assets without running this code.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';
import * as core from './core';
import { handleRpc, TOOLS } from './mcp';
import { oauth } from './oauth';
import * as views from './views';
import * as digest from './digest';
import * as github from './github';
import * as wake from './wake';
import * as merge from './merge';
import * as continuous from './continuous';
import * as ghapp from './githubapp';
import { VERSION } from './version';
import * as transfer from './transfer';
import * as waits from './waits';
import { readLicence } from './licence';
import { extensions, flushAudit } from './extensions';
import * as ping from './ping';
import * as oidc from './oidc';

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  LEASE_MINUTES?: string;
  SETUP_TOKEN?: string;
  PUBLIC_URL?: string;
  /** Licence key for the Enterprise edition (KD-75); unset = Community. */
  KUNLA_LICENSE?: string;
  /** "on" sends the daily anonymous usage ping (KD-69); off by default. */
  KUNLA_USAGE_PING?: string;
  KUNLA_PING_URL?: string;
  /** "true" on the Kunla that collects usage pings (Spiking Labs' own). */
  KUNLA_COLLECT_PINGS?: string;
  /** Sign in with Google or Microsoft (KD-68); see src/oidc.ts. */
  GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string;
  MICROSOFT_CLIENT_ID?: string; MICROSOFT_CLIENT_SECRET?: string; MICROSOFT_TENANT?: string;
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
  return { db: c.env.DB, me, space: me.space_id, baseUrl: baseUrl(c), leaseMinutes: Number(c.env.LEASE_MINUTES || 30), licence: await readLicence(c.env.KUNLA_LICENSE), notify: (w) => sendLater(c, wake.deliver(c.env.DB, w)),
    defer: (job) => sendLater(c, job()) };
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
app.get('/api/health', (c) => c.json({ ok: true, name: 'kunla', version: VERSION }));
app.get('/api/setup', async (c) => c.json({ set_up: await core.isSetUp(c.env.DB), needs_setup_token: !!c.env.SETUP_TOKEN }));
app.post('/api/setup', async (c) => {
  const body = await c.req.json<any>();
  if (c.env.SETUP_TOKEN && body.setup_token !== c.env.SETUP_TOKEN) return c.json({ error: 'Wrong setup token.' }, 403);
  return c.json(await core.setup(c.env.DB, body));
});
// Import a workspace export (KD-74). On a fresh Kunla it needs the setup token (header X-Kunla-Setup-Token) when
// one is set, and the workspace becomes this Kunla's first; on a set-up Kunla an admin adds it as another workspace.
app.post('/api/import', async (c) => {
  const fresh = !(await core.isSetUp(c.env.DB));
  if (fresh) {
    if (c.env.SETUP_TOKEN && c.req.header('x-kunla-setup-token') !== c.env.SETUP_TOKEN) return c.json({ error: 'Wrong setup token.' }, 403);
  } else {
    const ctx = await authenticate(c as C);
    if (!ctx) return c.json({ error: 'Sign in with a Kunla token (Authorization: Bearer kun_...).' }, 401);
    if (ctx.me.kind !== 'human' || !JSON.parse(ctx.me.roles || '[]').includes('admin')) return c.json({ error: 'Only admins can import a workspace.' }, 403);
  }
  const data = await c.req.json().catch(() => null);
  return c.json(await transfer.importWorkspace(c.env.DB, data, { fresh }));
});
// Which edition this Kunla runs and how people can sign in (KD-75). Public: the sign-in page needs it.
app.get('/api/edition', async (c) => {
  const l = await readLicence(c.env.KUNLA_LICENSE);
  const signIn = [...oidc.options(c.env), ...extensions().signIn.filter((p) => l.features.includes(p.feature)).map((p) => ({ id: p.id, label: p.label, url: `/auth/${p.id}/start` }))];
  return c.json({ edition: l.edition, licensee: l.licensee, features: l.features, seats: l.seats, expires_at: l.expires_at, problem: l.problem, sign_in: signIn, version: VERSION });
});
// Sign in with a work Google or Microsoft account (KD-68): free in the core. Errors go back to the sign-in page.
const signInError = (c: C, e: unknown) => c.redirect(`/app/?signin_error=${encodeURIComponent(e instanceof Error ? e.message : 'Sign-in failed.')}`);
app.get('/auth/:id{google|microsoft}/start', async (c) => {
  try { return await oidc.start(c.env, c.req.param('id'), baseUrl(c)); } catch (e) { return signInError(c, e); }
});
app.get('/auth/:id{google|microsoft}/callback', async (c) => {
  try {
    const r = await oidc.callback(c.env, c.env.DB, c.req.param('id'), c.req.raw, baseUrl(c));
    return new Response(null, { status: 302, headers: { location: `/app/#/use/${encodeURIComponent(r.token)}`, 'set-cookie': r.clearCookie } });
  } catch (e) { return signInError(c, e); }
});
// Sign-in providers registered by ee/ (SSO). A provider hands back a member; Kunla gives them a fresh token and
// opens the web app with it, the same way switching workspace does.
app.all('/auth/:id/*', async (c) => {
  const l = await readLicence(c.env.KUNLA_LICENSE);
  const p = extensions().signIn.find((x) => x.id === c.req.param('id') && l.features.includes(x.feature));
  if (!p) return c.json({ error: 'No such sign-in on this Kunla.' }, 404);
  const rest = new URL(c.req.url).pathname.slice(`/auth/${p.id}/`.length);
  const r = await p.handle(c.req.raw, rest, c.env as unknown as Record<string, unknown>, c.env.DB);
  if (r instanceof Response) return r;
  if ((r as { removed_at?: string | null }).removed_at) return c.json({ error: 'This person was removed from Kunla.' }, 403);
  const token = await core.issueToken(c.env.DB, r.id, `sign-in:${p.id}`);
  return c.redirect(`/app/#/use/${encodeURIComponent(token)}`);
});
// Usage pings from copies that opted in (KD-69), accepted only where KUNLA_COLLECT_PINGS is "true".
app.post('/api/ping', async (c) => {
  if (c.env.KUNLA_COLLECT_PINGS !== 'true') return c.json({ error: 'This Kunla does not collect usage pings.' }, 404);
  return c.json(await ping.receive(c.env.DB, await c.req.json().catch(() => null)));
});
// GitHub calls this when a pull request or push happens; tasks cited by key update themselves.
app.post('/hooks/github', async (c) => {
  const ctx: core.Ctx = { db: c.env.DB, me: null as any, space: '', baseUrl: baseUrl(c), leaseMinutes: Number(c.env.LEASE_MINUTES || 30),
    notify: (w) => sendLater(c, wake.deliver(c.env.DB, w)) };
  const r = await github.handleWebhook(ctx, c.req.raw);
  return c.json(r.body, r.status as any);
});
// The Kunla GitHub App round trips (browser navigations from github.com, so no bearer token: a
// one-time state the admin's own request made ties each one to their workspace).
app.get('/hooks/github/app/created', async (c) => c.redirect(await ghapp.created(c.env.DB, c.req.query('code'), c.req.query('state'))));
app.get('/hooks/github/app/installed', async (c) => c.redirect(await ghapp.installed(c.env.DB, c.req.query('installation_id'), c.req.query('state'))));
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
api.post('/tasks/assign', async (c) => c.json(await core.assignMany(c.get('ctx'), await c.req.json())));
api.patch('/tasks/:key', async (c) => c.json(await core.updateTask(c.get('ctx'), c.req.param('key'), await c.req.json())));
api.post('/tasks/:key/claim', async (c) => c.json(await core.claimTask(c.get('ctx'), c.req.param('key'), (await c.req.json<any>().catch(() => ({})))?.session)));
api.post('/tasks/:key/release', async (c) => c.json(await core.releaseTask(c.get('ctx'), c.req.param('key'), await c.req.json())));
api.post('/tasks/:key/takeover', async (c) => c.json(await core.takeOverTask(c.get('ctx'), c.req.param('key'), await c.req.json().catch(() => ({})))));
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
// Waiting on and assumptions (KD-84). Adding, ticking and removing waits goes through PATCH /tasks/:key
// (waiting_on, waits_met, not_waiting_on); a person settles an assumption here.
api.post('/assumptions/:id', async (c) => c.json(await waits.settleAssumption(c.get('ctx'), c.req.param('id'), await c.req.json())));
api.get('/relations', async (c) => c.json(await waits.graph(c.get('ctx'), { project: c.req.query('project') || undefined, focus: c.req.query('focus') || undefined, subtasks: c.req.query('subtasks') === '1' })));
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
api.get('/export', async (c) => {
  const data = await transfer.exportWorkspace(c.get('ctx'));
  const name = `kunla-${data.workspace.key.toLowerCase()}-${data.exported_at.slice(0, 10)}.json`;
  return c.json(data, 200, { 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
});
// What this copy's usage ping sends (or would send), and whether it is on (KD-69). Admins only.
api.get('/ping/preview', async (c) => {
  const ctx = c.get('ctx');
  if (ctx.me.kind !== 'human' || !JSON.parse(ctx.me.roles || '[]').includes('admin')) return c.json({ error: 'Only admins can see the usage ping.' }, 403);
  return c.json({ on: (c.env.KUNLA_USAGE_PING || '').toLowerCase() === 'on', url: c.env.KUNLA_PING_URL || ping.DEFAULT_PING_URL, ping: await ping.build(c.env.DB, (ctx.licence?.edition) ?? 'community') });
});
// On the collecting Kunla: how many copies are alive and how big (KD-69). Admins only.
api.get('/ping/summary', async (c) => {
  const ctx = c.get('ctx');
  if (c.env.KUNLA_COLLECT_PINGS !== 'true') return c.json({ error: 'This Kunla does not collect usage pings.' }, 404);
  if (ctx.me.kind !== 'human' || !JSON.parse(ctx.me.roles || '[]').includes('admin')) return c.json({ error: 'Only admins can see usage pings.' }, 403);
  return c.json(await ping.summary(c.env.DB));
});
api.post('/workspaces', async (c) => c.json(await core.createWorkspace(c.get('ctx'), await c.req.json())));
api.post('/members', async (c) => c.json(await core.addMember(c.get('ctx'), await c.req.json())));
api.get('/projects', async (c) => c.json(await core.listProjects(c.get('ctx'))));
api.get('/kinds', async (c) => c.json(await core.listKinds(c.get('ctx'))));
// The digest webhook works like a password for the channel, so the app only learns whether one is set.
api.get('/projects/:key', async (c) => { const p = await core.getProject(c.get('ctx'), c.req.param('key')); return c.json({ ...p, digest: p.kind === 'workspace' ? core.publicDigest(p.digest) : undefined }); });
api.post('/projects', async (c) => c.json(await core.createProject(c.get('ctx'), await c.req.json())));
api.patch('/projects/:key', async (c) => { const p = await core.updateProject(c.get('ctx'), c.req.param('key'), await c.req.json()); return c.json({ ...p, digest: p.kind === 'workspace' ? core.publicDigest(p.digest) : undefined }); });
// The weekly digest (KD-52): a preview anyone in the workspace can read, and "send it now" for admins.
api.get('/digest', async (c) => c.json(await digest.build(c.get('ctx'), Math.min(31, Math.max(1, Number(c.req.query('days')) || 7)))));
api.post('/digest/send', async (c) => {
  const ctx = c.get('ctx');
  if (ctx.me.kind !== 'human' || !JSON.parse(ctx.me.roles || '[]').includes('admin')) return c.json({ error: 'Only an admin can send the digest.' }, 403);
  const s = core.parseDigest((await core.getWorkspace(ctx)).digest);
  if (!s?.url) return c.json({ error: 'Add a webhook address for the digest first.' }, 400);
  return c.json(await digest.send(ctx, s));
});
api.get('/rules', async (c) => c.json(await views.rulesWithReach(c.get('ctx'), c.req.query('project'))));
// Without hours a person's briefing covers "since you were last here" (KD-49).
api.get('/briefing', async (c) => { const h = Number(c.req.query('hours')); return c.json(await views.briefing(c.get('ctx'), h > 0 ? h : undefined)); });
api.get('/changes', async (c) => c.json(await views.changes(c.get('ctx'))));
api.get('/progress', async (c) => c.json(await views.progress(c.get('ctx'))));
api.get('/pulse', async (c) => c.json(await views.pulse(c.get('ctx'))));
api.get('/map', async (c) => c.json(await views.workMap(c.get('ctx'), Math.min(14, Math.max(0.25, Number(c.req.query('days')) || 5)))));
api.post('/tasks/:key/comment', async (c) => c.json(await core.updateTask(c.get('ctx'), c.req.param('key'), { note: (await c.req.json<any>()).text })));
api.patch('/rules/:id', async (c) => { await core.setRuleActive(c.get('ctx'), c.req.param('id'), !!(await c.req.json<any>()).active); return c.json({ ok: true }); });

api.get('/integrations/github', async (c) => c.json(await github.connectionInfo(c.get('ctx'))));
api.post('/integrations/github/app', async (c) => c.json(await ghapp.start(c.get('ctx'), await c.req.json().catch(() => ({})))));
// The PR behind a task in Review, with its checks, so the review card can say "Approve and merge PR #N".
api.get('/tasks/:key/pr', async (c) => {
  const ctx = c.get('ctx');
  const t = await core.getTask(ctx, c.req.param('key'));
  const pr = await merge.taskPr(c.env.DB, t.id);
  if (!pr) return c.json({ pr: null });
  const token = await merge.tokenFor(ctx, pr);
  if (!token) return c.json({ pr, merge_by: 'agent' });
  try { return c.json({ pr, merge_by: 'kunla', ...(await merge.prState(token, pr)) }); }
  catch (e) { return c.json({ pr, merge_by: 'kunla', error: (e as Error).message }); }
});

app.route('/api', api);

// Anything else falls through to the static web app.
app.all('*', (c) => (c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('Not found', 404)));

// Cron (wrangler.toml [triggers]): at the start of each UTC day, wake continuous agents that stopped on a daily budget
// and send the weekly digests due today.
export async function scheduled(_e: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
  const base = (env.PUBLIC_URL || '').replace(/\/$/, '');
  const jobs: Promise<unknown>[] = [];
  await continuous.newDay({ db: env.DB, baseUrl: base, leaseMinutes: Number(env.LEASE_MINUTES || 30), notify: (w) => { jobs.push(wake.deliver(env.DB, w).catch((e) => console.error('wake failed', e))); } });
  // Weekly digests whose day is today (KD-52).
  jobs.push(digest.sendDue({ db: env.DB, baseUrl: base, leaseMinutes: Number(env.LEASE_MINUTES || 30) }).catch((e) => console.error('digest failed', e)));
  // The anonymous usage ping, for copies that turned it on (KD-69).
  jobs.push(readLicence(env.KUNLA_LICENSE).then((l) => ping.send(env.DB, env, l.edition)));
  // Audit export to the company's log tools, when ee/ registered a sink and the licence has it (KD-75).
  if (extensions().audit.length) jobs.push(flushAudit(env.DB, env as unknown as Record<string, unknown>, await readLicence(env.KUNLA_LICENSE)).catch((e) => console.error('audit failed', e)));
  ctx.waitUntil(Promise.all(jobs));
}

export default { fetch: app.fetch, scheduled };
