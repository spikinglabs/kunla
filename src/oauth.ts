// Minimal OAuth 2.1 (authorization code + PKCE, dynamic client registration) so chat apps such as
// claude.ai can add Kunla as a custom connector. Each approved connection becomes its own AI member,
// sponsored by the person who approved it, with its own token.
import { Hono } from 'hono';
import type { Context } from 'hono';
import * as core from './core';
import type { Env } from './index';

export const oauth = new Hono<{ Bindings: Env }>();
const origin = (c: Context<any>) => (c.env.PUBLIC_URL || new URL(c.req.url).origin).replace(/\/$/, '');

async function protectedResource(c: Context<any>) {
  // /mcp/<KEY> is one workspace's address; its OAuth flow signs in to that workspace (see authorize.html).
  const key: string | undefined = c.req.param('ws');
  const ws = key ? await core.workspaceByKey(c.env.DB, key) : null;
  if (key && !ws) return c.json({ error: 'No such workspace' }, 404);
  return c.json({
    resource: `${origin(c)}/mcp${ws ? '/' + ws.key : ''}`,
    authorization_servers: [origin(c)],
    bearer_methods_supported: ['header'],
    resource_name: 'Kunla',
  });
}
oauth.get('/.well-known/oauth-protected-resource', protectedResource);
oauth.get('/.well-known/oauth-protected-resource/mcp', protectedResource);
oauth.get('/.well-known/oauth-protected-resource/mcp/:ws', protectedResource);

const authServer = (c: Context<any>) => c.json({
  issuer: origin(c),
  authorization_endpoint: `${origin(c)}/oauth/authorize`,
  token_endpoint: `${origin(c)}/oauth/token`,
  registration_endpoint: `${origin(c)}/oauth/register`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
});
oauth.get('/.well-known/oauth-authorization-server', authServer);
// Some clients look for the metadata under the resource's path too; it is the same server.
oauth.get('/.well-known/oauth-authorization-server/mcp/:ws', authServer);
oauth.get('/.well-known/openid-configuration/mcp/:ws', authServer);

/** The workspace an OAuth request is for, from its resource (…/mcp/KEY); null means any workspace. */
export function workspaceKeyFromResource(resource: unknown): string | null {
  if (typeof resource !== 'string') return null;
  try { return new URL(resource).pathname.match(/^\/mcp\/([A-Za-z][A-Za-z0-9]{1,9})\/?$/)?.[1]?.toUpperCase() ?? null; } catch { return null; }
}

oauth.post('/oauth/register', async (c) => {
  const body = await c.req.json<any>().catch(() => ({}));
  const uris: string[] = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (!uris.length || !uris.every((u) => /^https:\/\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u)))
    return c.json({ error: 'invalid_redirect_uri' }, 400);
  const id = crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?,?,?,?)')
    .bind(id, String(body.client_name ?? 'MCP client').slice(0, 80), JSON.stringify(uris), new Date().toISOString()).run();
  return c.json({
    client_id: id, client_name: body.client_name, redirect_uris: uris,
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'],
  }, 201);
});

// The consent page is static; it signs in with the person's Kunla token from the web app.
oauth.get('/oauth/authorize', async (c) => {
  if (!c.env.ASSETS) return c.text('Consent page not available', 500);
  const res = await c.env.ASSETS.fetch(new Request(new URL('/authorize.html', c.req.url)));
  return new Response(res.body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
});

oauth.get('/oauth/client/:id', async (c) => {
  const client = await c.env.DB.prepare('SELECT id, name, redirect_uris FROM oauth_clients WHERE id = ?').bind(c.req.param('id')).first<any>();
  if (!client) return c.json({ error: 'Unknown client' }, 404);
  return c.json({ id: client.id, name: client.name, redirect_uris: JSON.parse(client.redirect_uris) });
});

oauth.post('/oauth/approve', async (c) => {
  const h = c.req.header('authorization') ?? '';
  const me = h.startsWith('Bearer ') ? await core.memberForToken(c.env.DB, h.slice(7)) : null;
  if (!me || me.kind !== 'human') return c.json({ error: 'Sign in to Kunla as a person first.' }, 401);
  const b = await c.req.json<any>();
  const client = await c.env.DB.prepare('SELECT * FROM oauth_clients WHERE id = ?').bind(b.client_id).first<any>();
  if (!client) return c.json({ error: 'Unknown client.' }, 400);
  if (!JSON.parse(client.redirect_uris).includes(b.redirect_uri)) return c.json({ error: 'Redirect URI not registered.' }, 400);
  if (!b.code_challenge || (b.code_challenge_method ?? 'S256') !== 'S256') return c.json({ error: 'PKCE S256 is required.' }, 400);
  // A connector added at /mcp/KEY must join that workspace, or its token would be turned away there.
  const wsKey = workspaceKeyFromResource(b.resource);
  if (wsKey) {
    const ws = await core.workspaceByKey(c.env.DB, wsKey);
    if (!ws) return c.json({ error: `No workspace ${wsKey} on this Kunla.` }, 400);
    if (ws.id !== me.space_id) return c.json({ error: `This connector is for ${ws.name}. Sign in with your token for ${ws.name}.`, workspace: { key: ws.key, name: ws.name } }, 403);
  }

  const ctx: core.Ctx = { db: c.env.DB, me, space: me.space_id, baseUrl: origin(c), leaseMinutes: Number(c.env.LEASE_MINUTES || 30) };
  const name = String(b.name || `${me.name}'s ${client.name}`).slice(0, 80);
  const existing = await c.env.DB.prepare('SELECT * FROM members WHERE lower(name) = lower(?) AND sponsor_id = ? AND removed_at IS NULL AND space_id = ?').bind(name, me.id, me.space_id).first<core.Member>();
  const member = existing ?? (await core.addMember(ctx, { name, kind: 'ai', platform: b.platform || 'claude-ai' })).member;

  const code = core.newToken().replace('kun_', 'code_');
  await c.env.DB.prepare('INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, member_id, expires_at) VALUES (?,?,?,?,?,?)')
    .bind(await core.sha256(code), client.id, b.redirect_uri, b.code_challenge, member.id, new Date(Date.now() + 5 * 60_000).toISOString()).run();
  const url = new URL(b.redirect_uri);
  url.searchParams.set('code', code);
  if (b.state) url.searchParams.set('state', b.state);
  return c.json({ redirect: url.toString(), member: member.name });
});

async function s256(verifier: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

oauth.post('/oauth/token', async (c) => {
  const ct = c.req.header('content-type') ?? '';
  const p: Record<string, string> = ct.includes('json') ? await c.req.json() : Object.fromEntries((new URLSearchParams(await c.req.text()) as any).entries());
  if (p.grant_type !== 'authorization_code') return c.json({ error: 'unsupported_grant_type' }, 400);
  const hash = await core.sha256(p.code ?? '');
  const row = await c.env.DB.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').bind(hash).first<any>();
  await c.env.DB.prepare('DELETE FROM oauth_codes WHERE code_hash = ? OR expires_at < ?').bind(hash, new Date().toISOString()).run();
  if (!row || row.expires_at < new Date().toISOString()) return c.json({ error: 'invalid_grant' }, 400);
  if ((p.client_id && p.client_id !== row.client_id) || (p.redirect_uri && p.redirect_uri !== row.redirect_uri)) return c.json({ error: 'invalid_grant' }, 400);
  if (!p.code_verifier || (await s256(p.code_verifier)) !== row.code_challenge) return c.json({ error: 'invalid_grant', error_description: 'PKCE check failed' }, 400);
  const token = await core.issueToken(c.env.DB, row.member_id, `oauth:${row.client_id}`);
  return c.json({ access_token: token, token_type: 'Bearer', scope: 'kunla' }, 200, { 'Cache-Control': 'no-store' });
});
