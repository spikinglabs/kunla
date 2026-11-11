// KD-69: the opt-in anonymous usage ping.
import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';
import { makeD1 } from './d1-shim';
import * as ping from '../src/ping';

const call = async (env: any, method: string, path: string, token?: string, body?: unknown) => {
  const res = await app.fetch(new Request(`https://kunla.test${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

let env: any, admin: string, ai: string;
beforeEach(async () => {
  env = { DB: makeD1(), LEASE_MINUTES: '30' };
  admin = (await call(env, 'POST', '/api/setup', undefined, { name: 'L', project_key: 'KD', project_name: 'Kunla Dev' })).body.token;
  ai = (await call(env, 'POST', '/api/members', admin, { name: "L's Claude", kind: 'ai' })).body.token;
  await call(env, 'POST', '/api/tasks', admin, { project: 'KD', title: 'Secret project name', status: 'ready' });
});

describe('usage ping', () => {
  it('is off by default and sends nothing', async () => {
    let calls = 0;
    expect(await ping.send(env.DB, {}, 'community', (async () => { calls++; return new Response('{}'); }) as any)).toEqual({ sent: false });
    expect(calls).toBe(0);
  });

  it('when on, sends only an anonymous id, the version and counts', async () => {
    let sent: any = null;
    const r = await ping.send(env.DB, { KUNLA_USAGE_PING: 'on', KUNLA_PING_URL: 'https://collect.test/api/ping' }, 'community',
      (async (url: string, init: any) => { sent = { url, body: JSON.parse(init.body) }; return new Response('{"ok":true}'); }) as any);
    expect(r.sent).toBe(true);
    expect(sent.url).toBe('https://collect.test/api/ping');
    expect(Object.keys(sent.body).sort()).toEqual(['agents', 'edition', 'install_id', 'people', 'tasks', 'tasks_7d', 'version', 'workspaces']);
    expect(sent.body).toMatchObject({ edition: 'community', workspaces: 1, people: 1, agents: 1, tasks: 1, tasks_7d: 1 });
    expect(JSON.stringify(sent.body)).not.toMatch(/Secret|Kunla Dev|KD|L's/);
    // The id stays the same from day to day.
    const again = await ping.build(env.DB, 'community');
    expect(again.install_id).toBe(sent.body.install_id);
  });

  it('shows admins exactly what it sends', async () => {
    expect((await call(env, 'GET', '/api/ping/preview', ai)).status).toBe(403);
    const r = await call(env, 'GET', '/api/ping/preview', admin);
    expect(r.body).toMatchObject({ on: false, url: ping.DEFAULT_PING_URL, ping: { people: 1 } });
  });

  it('is collected only where KUNLA_COLLECT_PINGS is on, one row per copy', async () => {
    const body = await ping.build(env.DB, 'community');
    expect((await call(env, 'POST', '/api/ping', undefined, body)).status).toBe(404);
    env.KUNLA_COLLECT_PINGS = 'true';
    expect((await call(env, 'POST', '/api/ping', undefined, body)).status).toBe(200);
    expect((await call(env, 'POST', '/api/ping', undefined, { ...body, tasks: 5 })).status).toBe(200);
    expect((await call(env, 'POST', '/api/ping', undefined, { ...body, install_id: 'x' })).status).toBe(400);
    expect((await call(env, 'POST', '/api/ping', undefined, { ...body, tasks: -1 })).status).toBe(400);
    expect((await call(env, 'GET', '/api/ping/summary', ai)).status).toBe(403);
    const s = await call(env, 'GET', '/api/ping/summary', admin);
    expect(s.body).toMatchObject({ ever: 1, active_7d: 1, active_30d: 1, people_30d: 1, working_30d: 1, versions: [{ copies: 1 }] });
  });
});
