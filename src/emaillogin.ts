// Sign in with an emailed link (KD-70), for people without a Google, Microsoft or GitHub account at work. Kunla
// emails a one-time link (15 minutes) to an address that belongs to a person here; opening it signs them in to
// every workspace with that email, as the other sign-ins do (KD-29). The link opens a page with a button, because
// mail scanners open links on their own and would otherwise use it up.
import { KunlaError, newToken, sha256 } from './core';
import { type MailEnv, mailOn, send } from './mail';
import { membersFor, safeReturn } from './oidc';

const VALID_MINUTES = 15;
const PER_HOUR = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const option = (env: MailEnv) => (mailOn(env) ? [{ id: 'email', label: 'Email me a sign-in link', url: '/auth/email/start' }] : []);

/** Send the link. Says the same thing whether or not the email is known here, so nobody can probe who is. */
export async function start(env: MailEnv, db: D1Database, input: { email?: unknown; return?: unknown }, origin: string, fetcher: typeof fetch = fetch) {
  if (!mailOn(env)) throw new KunlaError(404, 'Email sign-in is not set up on this Kunla.');
  const email = String(input.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 200) throw new KunlaError(400, 'That is not an email address.');
  const done = { sent: true, message: `If ${email} belongs to someone on this Kunla, a sign-in link is on its way. It works once, for ${VALID_MINUTES} minutes.` };
  const known = await db.prepare(`SELECT 1 FROM members WHERE kind = 'human' AND removed_at IS NULL AND lower(email) = ? LIMIT 1`).bind(email).first();
  if (!known) return done;
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const recent = await db.prepare('SELECT COUNT(*) AS n FROM login_links WHERE email = ? AND created_at > ?').bind(email, hourAgo).first<{ n: number }>();
  if ((recent?.n ?? 0) >= PER_HOUR) throw new KunlaError(429, 'Too many sign-in links for this email. Wait an hour, or use your token.');
  const secret = newToken().replace(/^kun_/, '');
  const now = new Date();
  await db.prepare('INSERT INTO login_links (id, email, back, expires_at, created_at) VALUES (?,?,?,?,?)')
    .bind(await sha256(secret), email, safeReturn(typeof input.return === 'string' ? input.return : null), new Date(now.getTime() + VALID_MINUTES * 60_000).toISOString(), now.toISOString()).run();
  await send(env, { to: email, subject: 'Your Kunla sign-in link',
    text: `Open this link to sign in to Kunla (${origin.replace(/^https?:\/\//, '')}):\n\n${origin}/auth/email/open?t=${secret}\n\nIt works once, for ${VALID_MINUTES} minutes. If you didn't ask for it, ignore this email.` }, fetcher);
  return done;
}

/** The page the emailed link opens: one button, which signs in. */
export function openPage(secret: string) {
  const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to Kunla</title>
<style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f5f2;color:#1c1b19}
@media (prefers-color-scheme:dark){body{background:#151413;color:#eceae6}}main{text-align:center;padding:24px}
button{font:inherit;padding:12px 22px;border-radius:10px;border:0;background:#1c1b19;color:#fff;cursor:pointer}
@media (prefers-color-scheme:dark){button{background:#eceae6;color:#151413}}</style></head>
<body><main><h1>Sign in to Kunla</h1><form method="post" action="/auth/email/open"><input type="hidden" name="t" value="${esc(secret)}"><button>Sign in</button></form></main></body></html>`;
}

/** Use the link: once, before it expires. */
export async function finish(db: D1Database, secret: string) {
  const id = await sha256(secret || '');
  const now = new Date().toISOString();
  // Mark it used in the same statement that checks it, so two clicks can't both get in.
  const row = await db.prepare(`UPDATE login_links SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ? RETURNING email, back`)
    .bind(now, id, now).first<{ email: string; back: string | null }>();
  if (!row) throw new KunlaError(400, 'This sign-in link was already used or has expired. Ask for a new one.');
  return { ...(await membersFor(db, [row.email], '', 'email')), back: safeReturn(row.back) };
}
