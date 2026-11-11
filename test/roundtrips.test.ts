// KD-79. Measures D1 round trips per request: on Cloudflare each one is a network hop from the Worker to the
// database, so the number of sequential queries is what a person waits for, not the SQL itself.
import { it, expect } from 'vitest';
import app from '../src/index';
import { makeD1 } from './d1-shim';

// ms per simulated round trip. Large enough that the request's own CPU time (tens of ms for 150 tasks on a slow
// CI runner) can't round up into an extra hop, which made this test fail now and then.
const HOP = 100;
function slow(db: D1Database, stats: { n: number }) {
  const wrap = (s: any): any => new Proxy(s, { get(t, k) {
    const v = t[k];
    if (k === 'bind') return (...a: any[]) => wrap(v.apply(t, a));
    if (['first', 'all', 'run', 'raw'].includes(k as string)) return async (...a: any[]) => { stats.n++; await new Promise((r) => setTimeout(r, HOP)); return v.apply(t, a); };
    return typeof v === 'function' ? v.bind(t) : v;
  } });
  return new Proxy(db as any, { get(t, k) {
    if (k === 'prepare') return (sql: string) => wrap(t.prepare(sql));
    if (k === 'batch') return async (st: any[]) => { stats.n++; await new Promise((r) => setTimeout(r, HOP)); return t.batch(st); };
    return t[k];
  } });
}

it('keeps every page to a few database round trips', async () => {
  const raw = makeD1();
  const env: any = { DB: raw, LEASE_MINUTES: '30' };
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const res = await app.fetch(new Request(`https://kunla.test${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    return res.json() as any;
  };
  const s = await call('POST', '/api/setup', undefined, { name: 'L', project_key: 'pa', project_name: 'Alchemist' });
  const h = s.token;
  const ai = (await call('POST', '/api/members', h, { name: 'CC', kind: 'ai', platform: 'claude-code' })).token;
  for (let i = 0; i < 150; i++) await call('POST', '/api/tasks', h, { project: 'PA', title: `Task number ${i} about thing ${i % 7}`, brief: 'x'.repeat(200) + ' see acme/site#' + i });
  for (let i = 0; i < 12; i++) {
    await call('POST', `/api/tasks/PA-${i + 1}/claim`, ai);
    await call('POST', `/api/log`, ai, { task: `PA-${i + 1}`, summary: 'did a thing' });
    await call('POST', `/api/tasks/PA-${i + 1}/submit`, ai, { summary: 'done', deliverables: [{ url: `https://github.com/acme/site/pull/${i}` }] });
  }
  const ib = await call('GET', '/api/inbox', h); if (ib.count < 12) throw new Error('seed failed: inbox ' + JSON.stringify(ib).slice(0, 300));
  const stats = { n: 0 };
  env.DB = slow(raw, stats);
  // Sequential round trips allowed per request (before KD-79: Briefing 14, Task page 13, decision inbox 15).
  const budget: Record<string, number> = {
    '/api/me': 2, '/api/inbox': 5, '/api/briefing': 3, '/api/pulse': 3, '/api/rules': 2, '/api/progress': 3,
    '/api/tasks?status=ready&limit=200': 3, '/api/members': 2, '/api/tasks?limit=1000': 3, '/api/changes': 3,
    '/api/map?days=14': 4, '/api/tasks/PA-3': 5, '/api/projects': 2, '/api/kinds': 2,
  };
  const out: string[] = [];
  const hops: Record<string, number> = {};
  for (const p of Object.keys(budget)) {
    stats.n = 0; const t0 = Date.now();
    await call('GET', p, h);
    hops[p] = Math.round((Date.now() - t0) / HOP);
    out.push(`${p.padEnd(36)} queries=${String(stats.n).padStart(3)}  round trips=${hops[p]}`);
  }
  // The Briefing loads its seven requests at once, so the page waits for the slowest one.
  stats.n = 0; const t0 = Date.now();
  await Promise.all(['/api/inbox', '/api/briefing', '/api/pulse', '/api/rules', '/api/progress', '/api/tasks?status=ready&limit=200', '/api/members'].map((p) => call('GET', p, h)));
  const page = Math.round((Date.now() - t0) / HOP);
  out.push(`Briefing page (7 requests at once)   queries=${stats.n}  round trips=${page}`);
  if (process.env.KUNLA_ROUNDTRIPS) console.log('\n' + out.join('\n'));
  expect(Object.keys(budget).filter((p) => hops[p] > budget[p]).map((p) => `${p}: ${hops[p]} > ${budget[p]}`)).toEqual([]);
  expect(page).toBeLessThanOrEqual(5);
}, 120_000);
