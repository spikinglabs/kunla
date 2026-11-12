// CPU time per route without database time, to compare against the Workers free plan's 10 ms per request.
// Run: npm run bench:cpu (N=1500 npm run bench:cpu for a bigger record). Not part of npm test: timings vary by machine.
import { it } from 'vitest';
import app from '../src/index';
import { makeD1 } from '../test/d1-shim';

let dbMs = 0;
const timed = (fn: Function) => function (this: any, ...a: any[]) { const t = performance.now(); const p = fn.apply(this, a); dbMs += performance.now() - t; return p; };
function wrapStmt(s: any): any {
  return new Proxy(s, { get(t, k) {
    const v = t[k];
    if (k === 'bind') return (...a: any[]) => wrapStmt(v.apply(t, a));
    if (['first', 'all', 'run', 'raw', 'batched'].includes(k as string)) return timed(v.bind(t));
    return typeof v === 'function' ? v.bind(t) : v;
  } });
}
function wrapDb(d: any) {
  return { prepare: (sql: string) => wrapStmt(d.prepare(sql)), batch: async (st: any[]) => { const t = performance.now(); try { return await Promise.all(st.map((s) => s.batched())); } finally { /* inner timed */ } }, exec: d.exec } as any;
}

it('cpu per route', async () => {
  const raw = makeD1();
  const env: any = { DB: wrapDb(raw), LEASE_MINUTES: '30' };
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const res = await app.fetch(new Request(`https://k.test${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {}, passThroughOnException() {} } as any);
    return res.json<any>().catch(() => null);
  };
  const admin = (await call('POST', '/api/setup', undefined, { name: 'L', project_key: 'KD', project_name: 'Kunla Dev' })).token;
  const people: string[] = [];
  for (let i = 0; i < 6; i++) people.push((await call('POST', '/api/members', admin, { name: `P${i}`, kind: 'human' })).token);
  const ais: string[] = [];
  for (let i = 0; i < 4; i++) ais.push((await call('POST', '/api/members', admin, { name: `AI${i}`, kind: 'ai' })).token);
  for (const k of ['MKT', 'OPS', 'WEB', 'DAT']) await call('POST', '/api/projects', admin, { key: k, name: k });
  const keys = ['KD', 'MKT', 'OPS', 'WEB', 'DAT'];
  const N = Number(process.env.N || 600);
  for (let i = 0; i < N; i++) {
    const ai = ais[i % ais.length];
    const r = await call('POST', '/mcp', ai, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'log_work', arguments: { project: keys[i % 5], summary: `Did thing ${i} with some words about it`, status: i % 3 ? 'done' : 'in_progress' } } });
    if (i % 7 === 0) { const key = JSON.parse(r.result.content[0].text).key; await call('POST', '/mcp', ai, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'log_work', arguments: { task: key, summary: 'more' } } }); }
  }
  const routes: [string, string, string, any?][] = [
    ['GET', '/api/briefing', admin], ['GET', '/api/tasks', admin], ['GET', '/api/map', admin], ['GET', '/api/inbox', admin],
    ['GET', '/api/progress', admin], ['GET', '/api/pulse', admin], ['GET', '/api/changes', admin], ['GET', '/api/relations', admin],
    ['GET', '/api/digest', admin], ['GET', '/api/members', admin], ['GET', '/api/projects', admin], ['GET', '/api/tasks/KD-1', admin],
    ['GET', '/api/export', admin],
    ['POST', '/mcp', ais[0], { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'next_task', arguments: {} } }],
    ['POST', '/mcp', ais[0], { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }],
    ['POST', '/mcp', ais[0], { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }],
    ['POST', '/mcp', ais[1], { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'log_work', arguments: { project: 'KD', summary: 'bench' } } }],
    ['POST', '/mcp', ais[1], { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tasks', arguments: {} } }],
  ];
  const out: string[] = [];
  for (const [m, p, t, b] of routes) {
    for (let w = 0; w < 3; w++) await call(m, p, t, b); // warm
    const samples: number[] = [];
    for (let i = 0; i < 7; i++) { dbMs = 0; const t0 = performance.now(); await call(m, p, t, b); samples.push(performance.now() - t0 - dbMs); }
    samples.sort((a, c) => a - c);
    out.push(`${(b?.params?.name ?? b?.method ?? '').padEnd(10)} ${m} ${p.padEnd(18)} median ${samples[3].toFixed(2)} ms  max ${samples[6].toFixed(2)} ms`);
  }
  console.log(`tasks≈${N}\n` + out.join('\n'));
}, 600000);
