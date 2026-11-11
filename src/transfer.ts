// Export a workspace's whole record and import it into another Kunla (KD-74): the "no lock-in" promise.
// A hosted team can download everything and move to its own Cloudflare account, and a self-hoster can keep
// backups or move a workspace from one Kunla to another. The file is plain JSON: one array of rows per table,
// every column included, so it also opens in any tool.
import { KunlaError, type Ctx } from './core';
import { VERSION } from './version';

export const FORMAT = 'kunla-workspace';
export const FORMAT_VERSION = 1;

// Each table with the SQL that picks this workspace's rows. Deployment-wide tables (settings with the GitHub App's
// credentials, OAuth clients and codes, webhook bookkeeping) stay behind: they belong to the deployment, not the team.
const TABLES: [string, string][] = [
  ['projects', 'SELECT * FROM projects WHERE space_id = ?1 ORDER BY kind = \'workspace\' DESC, created_at'],
  ['members', 'SELECT * FROM members WHERE space_id = ?1 ORDER BY created_at'],
  ['tokens', 'SELECT t.* FROM tokens t JOIN members m ON m.id = t.member_id WHERE m.space_id = ?1 ORDER BY t.created_at'],
  ['tasks', 'SELECT * FROM tasks WHERE space_id = ?1 ORDER BY created_at'],
  ['events', 'SELECT * FROM events WHERE space_id = ?1 ORDER BY id'],
  ['deliverables', 'SELECT d.* FROM deliverables d JOIN tasks t ON t.id = d.task_id WHERE t.space_id = ?1 ORDER BY d.created_at'],
  ['reviews', 'SELECT r.* FROM reviews r JOIN tasks t ON t.id = r.task_id WHERE t.space_id = ?1 ORDER BY r.created_at'],
  ['rules', 'SELECT r.* FROM rules r JOIN projects p ON p.id = r.project_id WHERE p.space_id = ?1 ORDER BY r.created_at'],
  ['task_sessions', 'SELECT s.* FROM task_sessions s JOIN tasks t ON t.id = s.task_id WHERE t.space_id = ?1 ORDER BY s.created_at'],
  ['task_notes', 'SELECT n.* FROM task_notes n JOIN tasks t ON t.id = n.task_id WHERE t.space_id = ?1 ORDER BY n.created_at'],
  ['waits', 'SELECT * FROM waits WHERE space_id = ?1 ORDER BY created_at'],
  ['assumptions', 'SELECT * FROM assumptions WHERE space_id = ?1 ORDER BY created_at'],
];

/** Tables that belong to the deployment, not a workspace, and so stay out of an export. A test makes every new
 *  table land in one list or the other, so a migration can't quietly leave a team's data out of its export. */
export const NOT_EXPORTED = ['settings', 'oauth_clients', 'oauth_codes', 'webhook_deliveries', 'webhook_log', 'usage_pings', 'd1_migrations', 'sqlite_sequence'];
export const EXPORTED = TABLES.map(([name]) => name);

export interface WorkspaceExport {
  format: typeof FORMAT;
  format_version: number;
  kunla_version: string;
  exported_at: string;
  workspace: { id: string; key: string; name: string };
  tables: Record<string, Record<string, unknown>[]>;
}

const isAdminHuman = (c: Ctx) => c.me.kind === 'human' && JSON.parse(c.me.roles || '[]').includes('admin');

/** Everything in the caller's workspace. Admins only: it includes every member's token hashes. */
export async function exportWorkspace(c: Ctx): Promise<WorkspaceExport> {
  if (!isAdminHuman(c)) throw new KunlaError(403, 'Only admins can export the workspace.');
  const ws = await c.db.prepare(`SELECT id, key, name FROM projects WHERE id = ? AND kind = 'workspace'`).bind(c.space)
    .first<{ id: string; key: string; name: string }>();
  if (!ws) throw new KunlaError(404, 'Workspace not found.');
  const results = await c.db.batch(TABLES.map(([, sql]) => c.db.prepare(sql).bind(c.space)));
  const tables: WorkspaceExport['tables'] = {};
  TABLES.forEach(([name], i) => { tables[name] = (results[i].results ?? []) as Record<string, unknown>[]; });
  return { format: FORMAT, format_version: FORMAT_VERSION, kunla_version: VERSION, exported_at: new Date().toISOString(), workspace: ws, tables };
}

async function columns(db: D1Database, table: string): Promise<Set<string>> {
  // table comes from TABLES above, never from the request.
  const rows = (await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results;
  return new Set(rows.map((r) => r.name));
}

/**
 * Adds an exported workspace to this Kunla, keeping every id, key and token, so links like /t/KD-12 and the
 * team's existing tokens keep working after a move. Refuses, changing nothing, when any of its keys, ids or
 * tokens already exist here. On a fresh Kunla (nobody set up yet) the empty starter workspace is replaced.
 * Columns this Kunla doesn't know (an export from a newer release) are left out; upgrade first to keep them.
 */
export async function importWorkspace(db: D1Database, data: unknown, opts: { fresh: boolean }) {
  const d = data as WorkspaceExport;
  if (!d || d.format !== FORMAT || typeof d.tables !== 'object' || !d.workspace?.id) {
    throw new KunlaError(400, 'This is not a Kunla workspace export.');
  }
  if (d.format_version > FORMAT_VERSION) throw new KunlaError(400, `This export is format ${d.format_version}; upgrade this Kunla to import it.`);
  let t = (name: string) => (Array.isArray(d.tables[name]) ? d.tables[name] : []);
  let space = d.workspace.id;
  const wsRow = t('projects').find((p) => p.id === space && p.kind === 'workspace');
  if (!wsRow) throw new KunlaError(400, 'The export has no workspace row.');
  for (const name of ['projects', 'members', 'tasks', 'events', 'waits', 'assumptions']) {
    if (t(name).some((r) => r.space_id !== space)) throw new KunlaError(400, `The export mixes workspaces (${name}).`);
  }

  // On a fresh Kunla the empty starter workspace goes away, so it can't clash. Every Kunla's first workspace has
  // the same id from the migrations, so a workspace moving into a Kunla in use gets a new id (its keys stay).
  const starter = opts.fresh ? (await db.prepare(`SELECT id FROM projects WHERE kind = 'workspace' ORDER BY created_at LIMIT 1`).first<{ id: string }>())?.id : undefined;
  if (space !== starter && await db.prepare('SELECT 1 FROM projects WHERE id = ?').bind(space).first()) {
    const old = space;
    space = crypto.randomUUID();
    const remapped = Object.fromEntries(Object.entries(d.tables).map(([name, rows]) => [name, Array.isArray(rows)
      ? rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === old && (k === 'id' || k.endsWith('_id')) ? space : v]))) : rows]));
    t = (name: string) => (Array.isArray(remapped[name]) ? remapped[name] : []);
  }

  // Nothing may clash: workspace keys, ids and token hashes are unique across a Kunla. Project and task keys only
  // need to be unique inside their workspace, and the imported one is a workspace of its own (KD-70).
  const clash = async (sql: string, values: unknown[]) => {
    if (!values.length) return null;
    const q = db.prepare(sql.replace('$', 'SELECT value FROM json_each(?1)'));
    const row = await (sql.includes('?2') ? q.bind(JSON.stringify(values), starter ?? '') : q.bind(JSON.stringify(values))).first<Record<string, unknown>>();
    return row ? Object.values(row)[0] : null;
  };
  const checks: [string, string, unknown[]][] = [
    ['workspace key', `SELECT key FROM projects WHERE kind = 'workspace' AND key IN ($) AND id != ?2`, t('projects').filter((p) => p.kind === 'workspace').map((p) => p.key)],
    ['project', 'SELECT id FROM projects WHERE id IN ($)', t('projects').map((p) => p.id).filter((x) => x !== starter)],
    ['member', 'SELECT id FROM members WHERE id IN ($)', t('members').map((m) => m.id)],
    ['task', 'SELECT key FROM tasks WHERE id IN ($)', t('tasks').map((x) => x.id)],
    ['token', 'SELECT id FROM tokens WHERE token_hash IN ($)', t('tokens').map((x) => x.token_hash)],
  ];
  for (const [what, sql, values] of checks) {
    const hit = await clash(sql, values);
    if (hit) throw new KunlaError(409, `This Kunla already has ${what} ${hit}, so the workspace can't be imported here without mixing records.`);
  }

  const stmts: D1PreparedStatement[] = [];
  if (opts.fresh) {
    // The starter workspace the migrations create is empty until setup; the imported one takes its place.
    stmts.push(db.prepare(`DELETE FROM projects WHERE kind = 'workspace' AND id = ? AND NOT EXISTS (SELECT 1 FROM members)`).bind(starter ?? ''));
  }
  const counts: Record<string, number> = {};
  for (const [name] of TABLES) {
    const rows = t(name);
    counts[name] = rows.length;
    if (!rows.length) continue;
    const known = await columns(db, name);
    // Event ids are a running number per Kunla; new ones keep the original order.
    const skip = name === 'events' ? new Set(['id']) : new Set<string>();
    // Parents before children, so references inside a table (sponsors, parent tasks) resolve in order.
    const ordered = name === 'members' ? [...rows].sort((a, b) => Number(!!a.sponsor_id) - Number(!!b.sponsor_id))
      : name === 'tasks' ? sortParentsFirst(rows) : rows;
    // D1 counts statements per request and allows 100 bound values per statement, so each table goes in as one
    // JSON array (split in ~1 MB chunks) unpacked by SQLite's json_each, not as one INSERT per row.
    const cols = [...new Set(ordered.flatMap((r) => Object.keys(r)))].filter((k) => known.has(k) && !skip.has(k) && /^\w+$/.test(k));
    const sql = `INSERT INTO ${name} (${cols.join(',')}) SELECT ${cols.map((k) => `json_extract(value, '$.${k}')`).join(',')} FROM json_each(?) ORDER BY key`;
    for (const chunk of chunks(ordered, 1_000_000)) stmts.push(db.prepare(sql).bind(JSON.stringify(chunk)));
  }
  // One batch is one transaction in D1: the import lands whole or not at all.
  await db.batch(stmts);
  return { imported: true, workspace: { id: space, key: wsRow.key as string, name: wsRow.name as string }, counts };
}

function sortParentsFirst(rows: Record<string, unknown>[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const visit = (r: Record<string, unknown>) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    const p = r.parent_id ? byId.get(r.parent_id) : undefined;
    if (p) visit(p);
    out.push(r);
  };
  rows.forEach(visit);
  return out;
}

/** Splits rows into JSON arrays of at most about `limit` bytes each. */
function chunks(rows: Record<string, unknown>[], limit: number) {
  const out: Record<string, unknown>[][] = [];
  let cur: Record<string, unknown>[] = [];
  let size = 0;
  for (const r of rows) {
    const n = JSON.stringify(r).length + 1;
    if (cur.length && size + n > limit) { out.push(cur); cur = []; size = 0; }
    cur.push(r);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Delete a workspace and everything in it, for good (Kunla Cloud, when a pilot team leaves; KD-70). Children go
 * first so every foreign key holds; one D1 batch, so it all happens or nothing does. Its settings (plan, GitHub
 * links) are keyed by its id. The export above is how a team keeps a copy first.
 */
export async function deleteWorkspaceData(db: D1Database, space: string) {
  const ws = await db.prepare(`SELECT id, key FROM projects WHERE id = ? AND kind = 'workspace'`).bind(space).first<{ id: string; key: string }>();
  if (!ws) throw new KunlaError(404, 'No such workspace.');
  const inTasks = 'task_id IN (SELECT id FROM tasks WHERE space_id = ?1)';
  const inMembers = 'member_id IN (SELECT id FROM members WHERE space_id = ?1)';
  const sql = [
    `DELETE FROM deliverables WHERE ${inTasks}`,
    `DELETE FROM reviews WHERE ${inTasks}`,
    `DELETE FROM task_sessions WHERE ${inTasks}`,
    `DELETE FROM task_notes WHERE ${inTasks}`,
    'DELETE FROM waits WHERE space_id = ?1',
    'DELETE FROM assumptions WHERE space_id = ?1',
    'DELETE FROM events WHERE space_id = ?1',
    'DELETE FROM rules WHERE project_id IN (SELECT id FROM projects WHERE space_id = ?1)',
    'DELETE FROM tasks WHERE space_id = ?1',
    `DELETE FROM tokens WHERE ${inMembers}`,
    `DELETE FROM oauth_codes WHERE ${inMembers}`,
    'DELETE FROM members WHERE space_id = ?1',
    'DELETE FROM projects WHERE space_id = ?1',
    "DELETE FROM settings WHERE key LIKE '%' || ?1 || '%'",
  ];
  await db.batch(sql.map((q) => db.prepare(q).bind(space)));
  return { deleted: ws.key };
}
