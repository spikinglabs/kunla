// Sign in with Google or Microsoft (KD-68). People sign in with their work account instead of pasting a token;
// agents keep their tokens. This is plain OpenID Connect and stays free in the core. SAML and company-wide SSO
// with provisioning are ee/ features (KD-77).
//
// Setup (any one or both): GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET, or MICROSOFT_CLIENT_ID + MICROSOFT_CLIENT_SECRET
// + MICROSOFT_TENANT (your directory's tenant id, so only accounts your company manages can sign in). Redirect URI:
// <your Kunla>/auth/<google|microsoft>/callback. A person signs in when their account's email matches the email on
// their Kunla member (Team → Manage, or added with one).
import { KunlaError, issueToken } from './core';

export interface OidcEnv {
  GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string;
  MICROSOFT_CLIENT_ID?: string; MICROSOFT_CLIENT_SECRET?: string; MICROSOFT_TENANT?: string;
  /** GitHub sign-in: an OAuth app of your own, or (Kunla Cloud) the shared GitHub App's client. */
  GITHUB_LOGIN_CLIENT_ID?: string; GITHUB_LOGIN_CLIENT_SECRET?: string;
  GITHUB_APP_CLIENT_ID?: string; GITHUB_APP_CLIENT_SECRET?: string;
  KUNLA_TENANT?: string; KUNLA_CLOUD_HOOK?: string;
}

type Id = 'google' | 'microsoft' | 'github';
interface Provider { id: Id; label: string; authorize: string; token: string; issuer: (iss: string) => boolean; clientId: string; secret: string; scope: string }

function providers(env: OidcEnv): Provider[] {
  const out: Provider[] = [];
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) out.push({
    id: 'google', label: 'Sign in with Google', clientId: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET,
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', scope: 'openid email profile',
    issuer: (iss) => iss === 'https://accounts.google.com' || iss === 'accounts.google.com',
  });
  // One tenant only: a multi-tenant app would let any Microsoft directory's admin set any email on an account.
  const tenant = (env.MICROSOFT_TENANT || '').trim();
  if (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET && tenant && !['common', 'organizations', 'consumers'].includes(tenant.toLowerCase())) out.push({
    id: 'microsoft', label: 'Sign in with Microsoft', clientId: env.MICROSOFT_CLIENT_ID, secret: env.MICROSOFT_CLIENT_SECRET,
    authorize: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`,
    token: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, scope: 'openid email profile',
    issuer: (iss) => iss === `https://login.microsoftonline.com/${tenant}/v2.0`,
  });
  // GitHub is plain OAuth, not OpenID Connect: Kunla reads the account's verified emails and its login from the API.
  const ghId = env.GITHUB_LOGIN_CLIENT_ID || env.GITHUB_APP_CLIENT_ID, ghSecret = env.GITHUB_LOGIN_CLIENT_SECRET || env.GITHUB_APP_CLIENT_SECRET;
  if (ghId && ghSecret) out.push({
    id: 'github', label: 'Sign in with GitHub', clientId: ghId, secret: ghSecret, scope: 'read:user user:email',
    authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', issuer: () => false,
  });
  return out;
}

/**
 * Where the provider sends the browser back. On Kunla Cloud, Google and GitHub sign-in use one shared app for every
 * team, which only knows the Cloud's own address; the browser goes there and the router sends it on to the team
 * named before the dot in state. A team's own GitHub OAuth app (GITHUB_LOGIN_*) comes straight back.
 */
function routed(env: OidcEnv, p: Provider) {
  if (!env.KUNLA_TENANT || !env.KUNLA_CLOUD_HOOK) return false;
  return p.id === 'google' || (p.id === 'github' && !env.GITHUB_LOGIN_CLIENT_ID);
}
function callbackUrl(env: OidcEnv, p: Provider, origin: string) {
  if (routed(env, p)) {
    try { return `${new URL(env.KUNLA_CLOUD_HOOK!).origin}/auth/${p.id}/callback`; } catch { /* fall through */ }
  }
  return `${origin}/auth/${p.id}/callback`;
}
const statePrefix = (env: OidcEnv, p: Provider) => (routed(env, p) ? `${env.KUNLA_TENANT}.` : '');

/** The sign-in buttons this Kunla offers. */
export const options = (env: OidcEnv) => providers(env).map((p) => ({ id: p.id, label: p.label, url: `/auth/${p.id}/start` }));

const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = () => b64u(crypto.getRandomValues(new Uint8Array(32)));
const COOKIE = 'kunla_oidc';

function cookie(req: Request, name: string) {
  const m = (req.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/** Step 1: send the browser to Google or Microsoft, with a one-time state and PKCE verifier in a short cookie. */
export async function start(env: OidcEnv, id: string, origin: string, ret?: string | null): Promise<Response> {
  const p = providers(env).find((x) => x.id === id);
  if (!p) throw new KunlaError(404, 'This sign-in is not set up on this Kunla.');
  const state = statePrefix(env, p) + random(), verifier = random();
  const challenge = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const url = new URL(p.authorize);
  url.search = new URLSearchParams({
    client_id: p.clientId, response_type: 'code', scope: p.scope, redirect_uri: callbackUrl(env, p, origin),
    state, code_challenge: challenge, code_challenge_method: 'S256', ...(p.id === 'github' ? {} : { prompt: 'select_account' }),
  }).toString();
  const h = new Headers({ location: url.toString() });
  h.append('set-cookie', `${COOKIE}=${encodeURIComponent(`${p.id}.${state}.${verifier}`)}; Path=/auth/${p.id}; Max-Age=600; HttpOnly; Secure; SameSite=Lax`);
  const r = safeReturn(ret);
  h.append('set-cookie', `${COOKIE}_back=${r ? btoa(r) : ''}; Path=/auth/${p.id}; Max-Age=${r ? 600 : 0}; HttpOnly; Secure; SameSite=Lax`);
  return new Response(null, { status: 302, headers: h });
}

function payload(idToken: string): Record<string, unknown> {
  const part = idToken.split('.')[1] ?? '';
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((part.length + 3) % 4)), (c) => c.charCodeAt(0))));
}

/**
 * Step 2: the provider sends the browser back with a code. Kunla swaps it for an ID token directly with the
 * provider (over TLS, with the client secret and PKCE verifier, so the token needs no separate signature check),
 * reads the verified email and finds the person with that email. Returns their new token.
 */
export async function callback(env: OidcEnv, db: D1Database, id: string, req: Request, origin: string, fetcher: typeof fetch = fetch) {
  const p = providers(env).find((x) => x.id === id);
  if (!p) throw new KunlaError(404, 'This sign-in is not set up on this Kunla.');
  const q = new URL(req.url).searchParams;
  if (q.get('error')) throw new KunlaError(400, `${p.label.replace('Sign in with ', '')} said: ${q.get('error_description') || q.get('error')}`);
  const parts = (cookie(req, COOKIE) || '').split('.');
  const cid = parts[0], verifier = parts[parts.length - 1], state = parts.slice(1, -1).join('.');
  if (cid !== p.id || !state || state !== q.get('state') || !verifier) throw new KunlaError(400, 'This sign-in link expired or was opened in another browser. Start again.');
  const res = await fetcher(p.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({
    grant_type: 'authorization_code', code: q.get('code') || '', redirect_uri: callbackUrl(env, p, origin),
    client_id: p.clientId, client_secret: p.secret, code_verifier: verifier,
  }).toString() });
  const tok = await res.json().catch(() => ({})) as { id_token?: string; access_token?: string; error_description?: string };
  let email = '', login = '';
  if (p.id === 'github') {
    if (!res.ok || !tok.access_token) throw new KunlaError(400, `Sign-in failed: ${tok.error_description || res.status}.`);
    const gh = (path: string) => fetcher(`https://api.github.com${path}`, { headers: { authorization: `Bearer ${tok.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'kunla' } }).then((r) => (r.ok ? r.json() : null));
    const [user, emails] = await Promise.all([gh('/user'), gh('/user/emails')]) as [{ login?: string } | null, { email: string; verified: boolean; primary: boolean }[] | null];
    login = String(user?.login ?? '');
    // Only verified addresses count; any of them may be the one on the person's Kunla member.
    const verified = (emails ?? []).filter((e) => e.verified).sort((a, b) => Number(b.primary) - Number(a.primary)).map((e) => e.email.trim().toLowerCase());
    if (!login && !verified.length) throw new KunlaError(403, 'That GitHub account has no verified email address.');
    return finish(db, p, verified, login);
  }
  if (!res.ok || !tok.id_token) throw new KunlaError(400, `Sign-in failed: ${tok.error_description || res.status}.`);
  const c = payload(tok.id_token);
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(p.clientId) || !p.issuer(String(c.iss)) || Number(c.exp) * 1000 < Date.now()) throw new KunlaError(400, 'Sign-in failed: the account token is not for this Kunla.');
  // Google says whether the email is verified; in a single Microsoft tenant the company's admin manages emails.
  email = String((p.id === 'microsoft' ? c.email || c.preferred_username : c.email) || '').trim().toLowerCase();
  if (!email || (p.id === 'google' && c.email_verified !== true)) throw new KunlaError(403, 'That account has no verified email address.');
  return finish(db, p, [email], '');

  async function finish(db: D1Database, p: Provider, emails: string[], ghLogin: string) {
    const r = await membersFor(db, emails, ghLogin, p.id);
    return { ...r, back: back(req), clearCookie: `${COOKIE}=; Path=/auth/${p.id}; Max-Age=0; HttpOnly; Secure; SameSite=Lax` };
  }
}
/**
 * Email linking (KD-29): the person just proved they own these emails (and, for GitHub, the login), so they are
 * every member with one of them, in every workspace here. They get a fresh token for each; the one used last
 * opens, the others join the workspace menu, and the claude.ai approval page can offer them all.
 */
export async function membersFor(db: D1Database, emails: string[], ghLogin: string, via: string) {
  const ms = (await db.prepare(`SELECT id, name, space_id FROM members WHERE kind = 'human' AND removed_at IS NULL
      AND (lower(email) IN (SELECT value FROM json_each(?)) OR (? != '' AND lower(github_login) = lower(?)))
      ORDER BY seen_at IS NULL, seen_at DESC, created_at LIMIT 20`).bind(JSON.stringify(emails), ghLogin, ghLogin).all<{ id: string; name: string; space_id: string }>()).results;
  // One per workspace, the most recently used.
  const seen = new Set<string>();
  const mine = ms.filter((m) => !seen.has(m.space_id) && seen.add(m.space_id));
  const who = emails[0] ?? `@${ghLogin}`;
  if (!mine.length) throw new KunlaError(403, `Nobody with ${who} is on this Kunla yet. Ask an admin to add you with that email (Team → Add a person), then sign in again.`);
  const tokens: string[] = [];
  for (const m of mine) tokens.push(await issueToken(db, m.id, `sign-in:${via}`));
  return { member: mine[0], token: tokens[0], tokens };
}

// Where to land after signing in: the web app, or the claude.ai approval page that sent the person (KD-29).
// Only that page may be a destination, so a sign-in link can't be made to hand tokens to another page.
export const safeReturn = (r: string | null | undefined) => (r && /^\/oauth\/authorize\?[^#]*$/.test(r) ? r : null);
function back(req: Request) {
  const raw = cookie(req, `${COOKIE}_back`);
  try { return raw ? safeReturn(atob(raw)) : null; } catch { return null; }
}

export const _test = { payload };
