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
import { KunlaError, type Ctx } from './core';

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

export const getApp = (db: D1Database) => get<AppCreds>(db, APP_KEY);

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
  return s;
}
async function takeState(db: D1Database, s: string | undefined | null, kind: 'manifest' | 'install') {
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
export async function installed(db: D1Database, installationId: string | undefined, state: string | undefined, fetcher: typeof fetch = fetch): Promise<string> {
  const id = Number(installationId);
  const st = await takeState(db, state, 'install');
  const app = await getApp(db);
  if (!app || !Number.isInteger(id) || id <= 0) return '/app/#/team/github?gh=failed';
  const known = await getInstallation(db, id);
  if (!st) return known ? '/app/#/team/github?gh=updated' : '/app/#/team/github?gh=expired';
  // Ask GitHub, as the app, that this installation is really ours, and whose it is.
  const r = await fetcher(`${API}/app/installations/${id}`, { headers: ghHeaders(await appJwt(app)) });
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok) return '/app/#/team/github?gh=failed';
  await put(db, INSTALL_PREFIX + id, JSON.stringify({ space: st.space, account: d.account?.login ?? '', account_is_org: d.account?.type === 'Organization' }));
  return '/app/#/team/github?gh=connected';
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
export async function forget(db: D1Database, id: number | string) {
  await db.prepare('DELETE FROM settings WHERE key = ?').bind(INSTALL_PREFIX + id).run();
}

export async function info(c: Ctx) {
  const app = await getApp(c.db);
  if (!app) return { registered: false };
  return {
    registered: true, name: app.name, slug: app.slug, owner: app.owner, html_url: app.html_url, merge: app.merge,
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
