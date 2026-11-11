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
}

interface Provider { id: 'google' | 'microsoft'; label: string; authorize: string; token: string; issuer: (iss: string) => boolean; clientId: string; secret: string }

function providers(env: OidcEnv): Provider[] {
  const out: Provider[] = [];
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) out.push({
    id: 'google', label: 'Sign in with Google', clientId: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET,
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
    issuer: (iss) => iss === 'https://accounts.google.com' || iss === 'accounts.google.com',
  });
  // One tenant only: a multi-tenant app would let any Microsoft directory's admin set any email on an account.
  const tenant = (env.MICROSOFT_TENANT || '').trim();
  if (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET && tenant && !['common', 'organizations', 'consumers'].includes(tenant.toLowerCase())) out.push({
    id: 'microsoft', label: 'Sign in with Microsoft', clientId: env.MICROSOFT_CLIENT_ID, secret: env.MICROSOFT_CLIENT_SECRET,
    authorize: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`,
    token: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
    issuer: (iss) => iss === `https://login.microsoftonline.com/${tenant}/v2.0`,
  });
  return out;
}

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
export async function start(env: OidcEnv, id: string, origin: string): Promise<Response> {
  const p = providers(env).find((x) => x.id === id);
  if (!p) throw new KunlaError(404, 'This sign-in is not set up on this Kunla.');
  const state = random(), verifier = random();
  const challenge = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const url = new URL(p.authorize);
  url.search = new URLSearchParams({
    client_id: p.clientId, response_type: 'code', scope: 'openid email profile', redirect_uri: `${origin}/auth/${p.id}/callback`,
    state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
  }).toString();
  return new Response(null, { status: 302, headers: {
    location: url.toString(),
    'set-cookie': `${COOKIE}=${encodeURIComponent(`${p.id}.${state}.${verifier}`)}; Path=/auth/${p.id}; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
  } });
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
  const [cid, state, verifier] = (cookie(req, COOKIE) || '').split('.');
  if (cid !== p.id || !state || state !== q.get('state') || !verifier) throw new KunlaError(400, 'This sign-in link expired or was opened in another browser. Start again.');
  const res = await fetcher(p.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({
    grant_type: 'authorization_code', code: q.get('code') || '', redirect_uri: `${origin}/auth/${p.id}/callback`,
    client_id: p.clientId, client_secret: p.secret, code_verifier: verifier,
  }).toString() });
  const tok = await res.json().catch(() => ({})) as { id_token?: string; error_description?: string };
  if (!res.ok || !tok.id_token) throw new KunlaError(400, `Sign-in failed: ${tok.error_description || res.status}.`);
  const c = payload(tok.id_token);
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(p.clientId) || !p.issuer(String(c.iss)) || Number(c.exp) * 1000 < Date.now()) throw new KunlaError(400, 'Sign-in failed: the account token is not for this Kunla.');
  // Google says whether the email is verified; in a single Microsoft tenant the company's admin manages emails.
  const email = String((p.id === 'microsoft' ? c.email || c.preferred_username : c.email) || '').trim().toLowerCase();
  if (!email || (p.id === 'google' && c.email_verified !== true)) throw new KunlaError(403, 'That account has no verified email address.');
  // Several workspaces may know the same person: sign in to the one they used last; the workspace menu has the rest.
  const m = await db.prepare(`SELECT id, name FROM members WHERE kind = 'human' AND removed_at IS NULL AND lower(email) = ?
      ORDER BY seen_at IS NULL, seen_at DESC, created_at LIMIT 1`).bind(email).first<{ id: string; name: string }>();
  if (!m) throw new KunlaError(403, `Nobody with ${email} is on this Kunla yet. Ask an admin to add you with that email (Team → Add a person), then sign in again.`);
  return { member: m, token: await issueToken(db, m.id, `sign-in:${p.id}`), clearCookie: `${COOKIE}=; Path=/auth/${p.id}; Max-Age=0; HttpOnly; Secure; SameSite=Lax` };
}

export const _test = { payload };
