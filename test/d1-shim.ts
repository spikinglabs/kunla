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
  // What D1's batch gives back for one statement: rows for a read, changes for a write.
  async batched() { return /^\s*(SELECT|WITH)\b/i.test(this.sql) ? this.all() : this.run(); }
  async raw() { return this.s().all(...(this.args as any[])).map((r: any) => Object.values(r)); }
}

/** before: apply only migrations whose file name sorts before this, to test upgrading an older database. */
export function makeD1(path = ':memory:', opts: { before?: string } = {}): D1Database {
  const db = new DatabaseSync(path);
  const dir = join(new URL('.', import.meta.url).pathname, '..', 'migrations');
  const files = readdirSync(dir).filter((f: string) => f.endsWith('.sql')).sort();
  const applied = new Set<string>();
  const migrate = (upTo?: string) => {
    for (const f of files) if (!applied.has(f) && (!upTo || f < upTo)) { db.exec(readFileSync(join(dir, f), 'utf8')); applied.add(f); }
  };
  migrate(opts.before);
  return {
    prepare: (sql: string) => new Stmt(db, sql),
    batch: async (stmts: any[]) => Promise.all(stmts.map((s) => s.batched())),
    exec: async (sql: string) => { db.exec(sql); return { count: 0, duration: 0 }; },
    migrate: () => migrate(),
  } as unknown as D1Database;
}
