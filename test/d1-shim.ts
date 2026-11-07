// A tiny D1-compatible wrapper over node:sqlite, so tests (and later a laptop mode) run without Cloudflare.
import { createRequire } from 'node:module';
// Vite drops the node: prefix for sqlite, so load it through require.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
type DatabaseSync = any;
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

class Stmt {
  constructor(private db: DatabaseSync, private sql: string, private args: unknown[] = []) {}
  bind(...args: unknown[]) { return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? (a ? 1 : 0) : a))); }
  private s() { return this.db.prepare(this.sql); }
  async first<T>(col?: string): Promise<T | null> {
    const row = this.s().get(...(this.args as any[])) as any;
    if (!row) return null;
    return (col ? row[col] : { ...row }) as T;
  }
  async all<T>() { return { results: this.s().all(...(this.args as any[])).map((r: any) => ({ ...r })) as T[], success: true, meta: {} }; }
  async run() {
    const r = this.s().run(...(this.args as any[]));
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async raw() { return this.s().all(...(this.args as any[])).map((r: any) => Object.values(r)); }
}

export function makeD1(path = ':memory:'): D1Database {
  const db = new DatabaseSync(path);
  const dir = join(new URL('.', import.meta.url).pathname, '..', 'migrations');
  for (const f of readdirSync(dir).filter((f: string) => f.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, f), 'utf8'));
  return {
    prepare: (sql: string) => new Stmt(db, sql),
    batch: async (stmts: any[]) => Promise.all(stmts.map((s) => s.run())),
    exec: async (sql: string) => { db.exec(sql); return { count: 0, duration: 0 }; },
  } as unknown as D1Database;
}
