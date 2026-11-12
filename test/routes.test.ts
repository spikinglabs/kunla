// Workers static assets answer first unless a path is listed in run_worker_first, so a Worker
// route missing from that list never runs live (tests call the Worker directly and miss it).
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const toml = readFileSync('wrangler.toml', 'utf8');
const first: string[] = JSON.parse(/run_worker_first\s*=\s*(\[[^\]]*\])/.exec(toml)![1]);
const covered = (path: string) =>
  first.some((p) => (p.endsWith('/*') ? path.startsWith(p.slice(0, -1)) || path === p.slice(0, -2) : path === p));

describe('run_worker_first', () => {
  it('covers every Worker route', () => {
    const src = readdirSync('src').filter((f) => f.endsWith('.ts')).map((f) => readFileSync(`src/${f}`, 'utf8')).join('\n');
    const paths = [...src.matchAll(/\b(?:app|oauth)\.(?:get|post|put|patch|delete|all)\('(\/[^']*)'/g)].map((m) => m[1]);
    const api = [...src.matchAll(/\bapi\.(?:get|post|put|patch|delete|all)\('(\/[^']*)'/g)].map((m) => `/api${m[1]}`);
    expect(paths.length).toBeGreaterThan(10);
    expect([...paths, ...api].filter((p) => !covered(p))).toEqual([]);
  });
});
