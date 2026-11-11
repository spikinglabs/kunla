// "Connect with GitHub" in one click, with a GitHub App instead of hand-made webhooks and tokens.
//
// 1. An admin taps "Set up the Kunla app". Kunla posts a manifest to GitHub (the manifest flow), and
//    the admin only confirms on github.com. GitHub hands back the app's id, private key and webhook
//    secret, which Kunla stores. One app serves the whole deployment.
// 2. GitHub then shows the install page: the admin picks repositories, and GitHub sends them back to
//    Kunla, which links that installation to the admin's workspace.
// 3. The app's webhook delivers pull requests, pushes and check suites from those repositories by
//    itself (no secret to paste), and short-lived installation tokens merge approved PRs (no PAT).
//
// Permissions are the fewest that work: metadata, pull requests and checks read; contents read, or
// write only when the admin lets Kunla merge approved PRs (GitHub's merge API needs contents write).
// This is the only way to connect GitHub: hand-made webhook secrets and personal tokens are gone.
//
// Shared app (KD-71, for Kunla Cloud): when GITHUB_APP_ID and friends are set, every team uses one public Kunla
// app instead of creating its own. Teams only install it. Its setup URL and webhook point at the Kunla Cloud
// router, which sends each team's traffic to that team's Kunla: the install redirect by the team name at the start
// of `state` (KUNLA_TENANT), webhooks by installation id, which each Kunla reports once it has checked the
// install is really its admin's (KUNLA_CLOUD_HOOK). Because strangers share the app, an install is linked only
// after GitHub confirms, through the user sign-in GitHub runs during installation, that the person installing
// can see that installation.
import { KunlaError, isOwner, type Ctx } from './core';

const APP_KEY = 'github_app';                 // deployment-wide: {id, slug, pem, webhook_secret, ...}
const STATE_PREFIX = 'github_app_state:';     // one-time state for the manifest and install round trips
const INSTALL_PREFIX = 'github_installation:'; // installation id -> {space, account}
const STATE_MINUTES = 60;                     // GitHub's manifest code also lasts an hour
const API = 'https://api.github.com';

export interface AppCreds { id: number; slug: string; name: string; pem: string; webhook_secret: string; html_url: string; owner: string; owner_is_org: boolean; merge: boolean; created_at: string }
export interface Installation { space: string; account: string; account_is_org: boolean; id: number }

const isAdmin = (c: Ctx) => c.me?.kind === 'human' && JSON.parse(c.me.roles || '[]').includes('admin');
const nowIso = () => new Date().toISOString();

async function put(db: D1Database, key: string, value: string) {
  await db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(key, value, nowIso()).run();
}
async function get<T>(db: D1Database, key: string): Promise<T | null> {
  const r = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  if (!r) return null;
  try { return JSON.parse(r.value) as T; } catch { return null; }
}

export interface SharedEnv {
  GITHUB_APP_ID?: string; GITHUB_APP_SLUG?: string; GITHUB_APP_PRIVATE_KEY?: string; GITHUB_APP_WEBHOOK_SECRET?: string;
  GITHUB_APP_CLIENT_ID?: string; GITHUB_APP_CLIENT_SECRET?: string; GITHUB_APP_MERGE?: string;
  KUNLA_TENANT?: string; KUNLA_CLOUD_HOOK?: string; KUNLA_CLOUD_SECRET?: string;
}
interface Shared { app: AppCreds; clientId: string; clientSecret: string; tenant: string; hook: string; hookSecret: string }
let shared: Shared | null = null;

/** Read the shared app's settings from the environment (called on every request; cheap). */
export function configure(env: SharedEnv) {
  const id = Number(env.GITHUB_APP_ID);
  if (!id || !env.GITHUB_APP_SLUG || !env.GITHUB_APP_PRIVATE_KEY || !env.GITHUB_APP_WEBHOOK_SECRET || !env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_CLIENT_SECRET) { shared = null; return; }
  const slug = env.GITHUB_APP_SLUG;
  shared = {
    app: { id, slug, name: slug, pem: env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n'), webhook_secret: env.GITHUB_APP_WEBHOOK_SECRET, html_url: `https://github.com/apps/${slug}`,
      owner: '', owner_is_org: true, merge: env.GITHUB_APP_MERGE !== 'false', created_at: '' },
    clientId: env.GITHUB_APP_CLIENT_ID, clientSecret: env.GITHUB_APP_CLIENT_SECRET,
    tenant: (env.KUNLA_TENANT || '').trim(), hook: (env.KUNLA_CLOUD_HOOK || '').trim(), hookSecret: env.KUNLA_CLOUD_SECRET || '',
  };
}
export const isShared = () => !!shared;

export const getApp = async (db: D1Database) => shared?.app ?? get<AppCreds>(db, APP_KEY);

/** What GitHub asks for, and nothing more. */
export function permissions(merge: boolean) {
  return { metadata: 'read', pull_requests: 'read', checks: 'read', contents: merge ? 'write' : 'read' };
}

export function manifest(baseUrl: string, name: string, merge: boolean) {
  return {
    name: name.slice(0, 34),
    url: baseUrl,
    description: 'Pull requests and commits that cite a Kunla task key update the task by themselves.',
    hook_attributes: { url: `${baseUrl}/hooks/github`, active: true },
    redirect_url: `${baseUrl}/hooks/github/app/created`,
    setup_url: `${baseUrl}/hooks/github/app/installed`,
    setup_on_update: true,
    public: false,
    default_permissions: permissions(merge),
    default_events: ['pull_request', 'push', 'check_suite'],
  };
}

// ---------- one-time state ----------

async function newState(db: D1Database, data: { space: string; kind: 'manifest' | 'install'; merge?: boolean }) {
  const s = [...crypto.getRandomValues(new Uint8Array(18))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await put(db, STATE_PREFIX + s, JSON.stringify({ ...data, exp: Date.now() + STATE_MINUTES * 60_000 }));
  await db.prepare('DELETE FROM settings WHERE key LIKE ? AND updated_at < ?').bind(STATE_PREFIX + '%', new Date(Date.now() - STATE_MINUTES * 60_000).toISOString()).run();
  // With the shared app, the Kunla Cloud router reads the team name in front of the dot to send the admin home.
  return shared?.tenant ? `${shared.tenant}.${s}` : s;
}
async function takeState(db: D1Database, raw: string | undefined | null, kind: 'manifest' | 'install') {
  const s = raw && shared?.tenant && raw.startsWith(`${shared.tenant}.`) ? raw.slice(shared.tenant.length + 1) : raw;
  if (!s || !/^[0-9a-f]{36}$/.test(s)) return null;
  const v = await get<{ space: string; kind: string; merge?: boolean; exp: number }>(db, STATE_PREFIX + s);
  await db.prepare('DELETE FROM settings WHERE key = ?').bind(STATE_PREFIX + s).run();
  return v && v.kind === kind && v.exp > Date.now() ? v : null;
}

// ---------- the admin's taps ----------

/** Start: either the manifest to post to GitHub (no app yet) or the install page (app exists). */
export async function start(c: Ctx, input: { org?: string; merge?: boolean; name?: string }) {
  if (!isAdmin(c)) throw new KunlaError(403, 'Only admins can connect GitHub.');
  const app = await getApp(c.db);
  if (app) return { install_url: `${app.html_url}/installations/new?state=${await newState(c.db, { space: c.space, kind: 'install' })}` };
  // Registering the app is for the whole Kunla (every workspace uses it), so it is the owner's call.
  if (!isOwner(c.me)) throw new KunlaError(403, "Only this Kunla's owner can register its GitHub App. Ask them to connect GitHub once; then admins install it.");
  const org = String(input.org ?? '').trim();
  if (org && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(org)) throw new KunlaError(400, 'That is not a GitHub organization name.');
  const merge = input.merge !== false;
  const host = new URL(c.baseUrl).hostname;
  const name = String(input.name ?? '').trim() || `Kunla ${org || host}`;
  const state = await newState(c.db, { space: c.space, kind: 'manifest', merge });
  const action = org ? `https://github.com/organizations/${org}/settings/apps/new?state=${state}` : `https://github.com/settings/apps/new?state=${state}`;
  return { action, manifest: JSON.stringify(manifest(c.baseUrl, name, merge)) };
}

/** GitHub sends the admin back with a code: trade it for the app's credentials, then go install it. */
export async function created(db: D1Database, code: string | undefined, state: string | undefined, fetcher: typeof fetch = fetch): Promise<string> {
  if (shared) return '/app/#/team/github?gh=exists';
  const st = await takeState(db, state, 'manifest');
  if (!st) return '/app/#/team/github?gh=expired';
  if (await getApp(db)) return '/app/#/team/github?gh=exists';
  if (!code || !/^[\w-]{1,100}$/.test(code)) return '/app/#/team/github?gh=failed';
  const res = await fetcher(`${API}/app-manifests/${code}/conversions`, { method: 'POST', headers: ghHeaders() });
  const d: any = await res.json().catch(() => ({}));
  if (!res.ok || !d.id || !d.pem || !d.webhook_secret) return '/app/#/team/github?gh=failed';
  const app: AppCreds = { id: d.id, slug: d.slug, name: d.name, pem: d.pem, webhook_secret: d.webhook_secret, html_url: d.html_url || `https://github.com/apps/${d.slug}`,
    owner: d.owner?.login ?? '', owner_is_org: d.owner?.type === 'Organization', merge: st.merge !== false, created_at: nowIso() };
  await put(db, APP_KEY, JSON.stringify(app));
  return `${app.html_url}/installations/new?state=${await newState(db, { space: st.space, kind: 'install' })}`;
}

/** Back from the install page: link the installation to the workspace that started it. */
export async function installed(db: D1Database, installationId: string | undefined, state: string | undefined, fetcher: typeof fetch = fetch, code?: string): Promise<string> {
  const id = Number(installationId);
  const st = await takeState(db, state, 'install');
  const app = await getApp(db);
  if (!app || !Number.isInteger(id) || id <= 0) return '/app/#/team/github?gh=failed';
  const known = await getInstallation(db, id);
  if (!st) return known ? '/app/#/team/github?gh=updated' : '/app/#/team/github?gh=expired';
  // Shared app: anyone could paste another team's installation id here, so GitHub must confirm that the person
  // who just installed can see it. Before the id is trusted, the sign-in code becomes a user token, which lists their installations.
  if (shared && !(await userCanSee(id, code, fetcher))) return '/app/#/team/github?gh=failed';
  // Ask GitHub, as the app, that this installation is really ours, and whose it is.
  const r = await fetcher(`${API}/app/installations/${id}`, { headers: ghHeaders(await appJwt(app)) });
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok) return '/app/#/team/github?gh=failed';
  if (shared && known && known.space !== st.space) return '/app/#/team/github?gh=failed'; // already another workspace's
  await put(db, INSTALL_PREFIX + id, JSON.stringify({ space: st.space, account: d.account?.login ?? '', account_is_org: d.account?.type === 'Organization' }));
  await tellCloud('linked', id, fetcher);
  return '/app/#/team/github?gh=connected';
}

async function userCanSee(id: number, code: string | undefined, fetcher: typeof fetch): Promise<boolean> {
  if (!shared || !code || !/^[\w-]{1,100}$/.test(code)) return false;
  const t = await fetcher('https://github.com/login/oauth/access_token', { method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'Kunla' },
    body: JSON.stringify({ client_id: shared.clientId, client_secret: shared.clientSecret, code }) });
  const tok: any = await t.json().catch(() => ({}));
  if (!t.ok || !tok.access_token) return false;
  for (let page = 1; page <= 10; page++) {
    const r = await fetcher(`${API}/user/installations?per_page=100&page=${page}`, { headers: ghHeaders(tok.access_token) });
    const d: any = await r.json().catch(() => ({}));
    if (!r.ok) return false;
    const list: any[] = d.installations ?? [];
    if (list.some((i) => i.id === id)) return true;
    if (list.length < 100) return false;
  }
  return false;
}

/**
 * Shared app: tell the Kunla Cloud router which installations this Kunla owns, so it forwards their webhooks
 * here. Signed with KUNLA_CLOUD_SECRET (HMAC-SHA256 of the body, header x-kunla-signature-256). Best effort.
 */
export async function tellCloud(action: 'linked' | 'unlinked', id: number, fetcher: typeof fetch = fetch) {
  if (!shared?.hook || !shared.hookSecret) return;
  const body = JSON.stringify({ action, installation_id: id, tenant: shared.tenant, at: new Date().toISOString() });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(shared.hookSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  try { await fetcher(shared.hook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kunla-signature-256': `sha256=${sig}` }, body }); } catch { /* the router can re-sync later */ }
}

export async function getInstallation(db: D1Database, id: number | string): Promise<Installation | null> {
  const v = await get<Omit<Installation, 'id'>>(db, INSTALL_PREFIX + id);
  return v ? { ...v, id: Number(id) } : null;
}

export async function installations(db: D1Database, space: string): Promise<Installation[]> {
  const rows = (await db.prepare('SELECT key, value FROM settings WHERE key LIKE ?').bind(INSTALL_PREFIX + '%').all<{ key: string; value: string }>()).results;
  const out: Installation[] = [];
  for (const r of rows) { try { const v = JSON.parse(r.value); if (v.space === space) out.push({ ...v, id: Number(r.key.slice(INSTALL_PREFIX.length)) }); } catch { /* skip */ } }
  return out;
}

/** GitHub says the app was uninstalled: forget the link. */
export async function forget(db: D1Database, id: number | string, fetcher: typeof fetch = fetch) {
  await db.prepare('DELETE FROM settings WHERE key = ?').bind(INSTALL_PREFIX + id).run();
  await tellCloud('unlinked', Number(id), fetcher);
}

export async function info(c: Ctx) {
  const app = await getApp(c.db);
  if (!app) return { registered: false };
  return {
    registered: true, shared: !!shared, name: app.name, slug: app.slug, owner: app.owner, html_url: app.html_url, merge: app.merge,
    settings_url: `https://github.com/${app.owner_is_org ? `organizations/${app.owner}/settings` : 'settings'}/apps/${app.slug}`,
    install_url: `${app.html_url}/installations/new`,
    installations: (await installations(c.db, c.space)).map((i) => ({ id: i.id, account: i.account,
      manage_url: `https://github.com/${i.account_is_org ? `organizations/${i.account}/settings` : 'settings'}/installations/${i.id}` })),
  };
}

// ---------- tokens ----------

/** A short-lived installation token for a repository installed in this workspace, or null. */
export async function installationToken(c: Pick<Ctx, 'db' | 'space'>, owner: string, repo: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  const app = await getApp(c.db);
  if (!app) return null;
  const jwt = await appJwt(app);
  const r = await fetcher(`${API}/repos/${owner}/${repo}/installation`, { headers: ghHeaders(jwt) });
  if (!r.ok) return null;
  const inst: any = await r.json().catch(() => ({}));
  const link = inst.id ? await getInstallation(c.db, inst.id) : null;
  if (!link || link.space !== c.space) return null; // installed, but for another workspace
  const t = await fetcher(`${API}/app/installations/${inst.id}/access_tokens`, { method: 'POST', headers: { ...ghHeaders(jwt), 'content-type': 'application/json' },
    body: JSON.stringify({ repositories: [repo] }) });
  const d: any = await t.json().catch(() => ({}));
  return t.ok && d.token ? d.token : null;
}

function ghHeaders(bearer?: string): Record<string, string> {
  return { accept: 'application/vnd.github+json', 'user-agent': 'Kunla', 'x-github-api-version': '2022-11-28', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) };
}

// ---------- app JWT (RS256) ----------

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

export async function appJwt(app: Pick<AppCreds, 'id' | 'pem'>, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000) - 60; // GitHub allows for clock drift this way
  const head = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat, exp: iat + 540, iss: String(app.id) })}`;
  const key = await crypto.subtle.importKey('pkcs8', pemToPkcs8(app.pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head)));
  return `${head}.${b64url(sig)}`;
}

/** GitHub gives a PKCS#1 key ("BEGIN RSA PRIVATE KEY"); WebCrypto wants PKCS#8, so wrap it. */
export function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0));
  if (/BEGIN PRIVATE KEY/.test(pem)) return der.buffer;
  const len = (n: number) => n < 128 ? [n] : n < 256 ? [0x81, n] : n < 65536 ? [0x82, n >> 8, n & 255] : [0x83, n >> 16, (n >> 8) & 255, n & 255];
  const tlv = (tag: number, content: number[]) => [tag, ...len(content.length), ...content];
  const rsaAlg = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  return new Uint8Array(tlv(0x30, [0x02, 0x01, 0x00, ...rsaAlg, ...tlv(0x04, [...der])])).buffer;
}
