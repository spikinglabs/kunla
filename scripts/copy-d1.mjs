// KD-80 one-off: build an SQL file that recreates database FROM inside TO (schema + rows), with
// parents inserted before children so foreign keys hold at every step. Uses wrangler, so it needs
// CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [from, out = 'dump.sql'] = process.argv.slice(2);
const q = (sql) => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', from, '--remote', '--json', '--command', sql], { maxBuffer: 1 << 28 }).toString())[0].results;
const lit = (v) => v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? '1' : '0') : `'${String(v).replace(/'/g, "''")}'`;

const schema = q(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`);
const tables = schema.filter((s) => s.type === 'table').map((s) => s.name);
// Tables others point at come first; within a table, rows that point at another row of it wait for that row.
const order = ['members', 'projects', 'tasks', 'reviews', 'rules'];
const sorted = [...order.filter((t) => tables.includes(t)), ...tables.filter((t) => !order.includes(t)).sort()];
const selfRef = { members: 'sponsor_id', tasks: 'parent_id' };

const lines = ['PRAGMA defer_foreign_keys = true;'];
for (const s of schema.filter((s) => s.type === 'table')) lines.push(s.sql + ';');
const counts = {};
for (const t of sorted) {
  let rows = q(`SELECT * FROM "${t}"`);
  counts[t] = rows.length;
  const ref = selfRef[t];
  if (ref) {
    const done = new Set(); const ordered = [];
    let left = rows;
    while (left.length) {
      const next = left.filter((r) => !r[ref] || done.has(r[ref]) || !rows.some((x) => x.id === r[ref]));
      if (!next.length) { ordered.push(...left); break; }
      for (const r of next) { ordered.push(r); done.add(r.id); }
      left = left.filter((r) => !next.includes(r));
    }
    rows = ordered;
  }
  for (const r of rows) {
    const cols = Object.keys(r);
    lines.push(`INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map((c) => lit(r[c])).join(',')});`);
  }
}
for (const s of schema.filter((s) => s.type !== 'table')) lines.push(s.sql + ';');
writeFileSync(out, lines.join('\n') + '\n');
writeFileSync('counts.json', JSON.stringify(counts));
console.log(JSON.stringify(counts));
