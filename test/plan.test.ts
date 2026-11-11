// KD-72: Kunla Cloud plans. People are billed per person; agents are free; small teams start free.
import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import app from '../src/index';
import { makeD1 } from './d1-shim';

let env: any, admin: string;
const call = async (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await app.fetch(new Request(`https://kunla.test${path}`, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }), env);
  return { status: res.status, body: await res.json<any>() };
};
const signed = (method: string, body = '', secret = 'cloud-secret', ts = Math.floor(Date.now() / 1000)) =>
  call(method, '/api/cloud/plan', undefined, body || undefined, { 'x-kunla-timestamp': String(ts), 'x-kunla-signature-256': `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}` });
const addPerson = (name: string) => call('POST', '/api/members', admin, { name, kind: 'human' });

beforeEach(async () => {
  env = { DB: makeD1(), LEASE_MINUTES: '30', KUNLA_CLOUD_SECRET: 'cloud-secret', KUNLA_FREE_SEATS: '3' };
  admin = (await call('POST', '/api/setup', undefined, { name: 'L', project_key: 'KD', project_name: 'Kunla Dev' })).body.token;
});

describe('Kunla Cloud plans', () => {
  it('starts free for a small team; agents never use a seat', async () => {
    expect((await call('GET', '/api/edition')).body.plan).toEqual({ name: 'free', seats: 3 });
    expect((await addPerson('A')).status).toBe(200);
    expect((await addPerson('B')).status).toBe(200);
    const full = await addPerson('C');
    expect(full.status).toBe(402);
    expect(full.body.error).toMatch(/plan covers 3 people/);
    for (const n of ['Bot 1', 'Bot 2', 'Bot 3']) expect((await call('POST', '/api/members', admin, { name: n, kind: 'ai' })).status).toBe(200);
  });

  it('the control plane sets the plan and reads the head count, signed', async () => {
    const body = JSON.stringify({ name: 'team', seats: 10 });
    expect((await signed('PUT', body)).body).toMatchObject({ plan: { name: 'team', seats: 10 }, people: 1, agents: 0 });
    expect((await addPerson('A')).status).toBe(200);
    expect((await signed('GET')).body).toMatchObject({ plan: { name: 'team', seats: 10 }, people: 2 });
    expect((await signed('PUT', JSON.stringify({ name: 'big', seats: null }))).body.plan.seats).toBeNull();
    expect((await signed('PUT', JSON.stringify({ name: 'x', seats: 0 }))).status).toBe(400);
  });

  it('refuses unsigned, wrongly signed or old calls, and is absent when self-hosted', async () => {
    expect((await call('GET', '/api/cloud/plan')).status).toBe(401);
    expect((await signed('GET', '', 'wrong')).status).toBe(401);
    expect((await signed('GET', '', 'cloud-secret', Math.floor(Date.now() / 1000) - 600)).status).toBe(401);
    expect((await signed('PUT', JSON.stringify({ name: 'team', seats: 99 }), 'wrong')).status).toBe(401);
    delete env.KUNLA_CLOUD_SECRET;
    expect((await signed('GET')).status).toBe(404);
    expect((await call('GET', '/api/edition')).body.plan).toBeNull();
    for (const n of ['A', 'B', 'C', 'D']) expect((await addPerson(n)).status).toBe(200);
  });
});
