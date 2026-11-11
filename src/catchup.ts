// The agent's half of the standup (KD-51). A person catches up on the Briefing; an agent catches up
// when it starts a session: whoami and next_task carry what changed for it since it last called,
// so it never has to ask "did anyone answer me?" and nobody has to tell it. Each change is said once.
import type { Ctx } from './core';

const now = (c: Ctx) => (c.now ? c.now() : new Date());
const MAX_ITEMS = 20;
const parse = (s: string | null) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

/** Event types that matter to the agent holding, or having filed, a task. */
const TYPES = ['answered', 'approved', 'changes_requested', 'assigned', 'taken_over', 'accepted', 'declined', 'parked', 'unparked', 'lease_expired', 'decision_undone', 'rule_added', 'focus_on', 'focus_off', 'unblocked', 'assumption_confirmed', 'assumption_corrected'];

export interface CatchUpItem { what: string; key: string | null; title: string | null; line: string; by: string | null; at: string }
export interface CatchUp { since: string | null; first_session: boolean; count: number; items: CatchUpItem[]; note: string }

type Row = { type: string; note: string | null; data: string; created_at: string; actor_id: string | null; actor: string | null;
  key: string | null; title: string | null; assignee_id: string | null; created_by: string | null; project_key: string | null };

function line(r: Row, me: string): string | null {
  const d = parse(r.data);
  const by = r.actor ?? 'Kunla';
  const k = r.key ?? '';
  const quote = r.note ? `: "${r.note.length > 200 ? r.note.slice(0, 197) + '...' : r.note}"` : '';
  switch (r.type) {
    case 'answered': return `${by} answered your question on ${k}${quote}`;
    case 'approved': return `${by} approved ${k}.`;
    case 'changes_requested': return `${by} sent ${k} back${quote}`;
    case 'assigned': return d.to === me ? `${by} handed you ${k}${quote}` : null;
    case 'taken_over': return d.previous === me ? `${by} took ${k} over; it is no longer yours.` : d.to === me ? `${by} handed you ${k}${quote}` : null;
    case 'accepted': return `${by} accepted your proposal ${k}; it is Ready now.`;
    case 'declined': return `${by} declined your proposal ${k}${quote}`;
    case 'parked': return `${by} put ${k} off; leave it alone until it comes back.`;
    case 'unparked': return `${k} is back${r.actor ? ` (${by} brought it back)` : ''}.`;
    case 'lease_expired': return d.previous_assignee === me ? `Your claim on ${k} lapsed after no heartbeat, so it went back to Ready.` : null;
    case 'decision_undone': return `${by} undid the decision recorded on ${k}.`;
    case 'rule_added': return `New rule${r.project_key ? ` in ${r.project_key}` : ''} from ${by}: ${r.note ?? ''}`;
    case 'focus_on': return `${by} put ${r.note ?? 'a project'} in focus; next_task offers it first.`;
    case 'focus_off': return `${by} took ${r.note ?? 'a project'} out of focus.`;
    case 'unblocked': return `${k} is no longer waiting: ${r.note ?? 'what it waited on happened'}.`.replace(/\.\.$/, '.');
    case 'assumption_confirmed': return `${by} confirmed your assumption on ${k}: "${r.note ?? ''}".`;
    case 'assumption_corrected': return `${by} corrected an assumption on ${k}${quote} Adjust the work.`;
    default: return null;
  }
}

/**
 * What changed for the calling agent since it last called whoami or next_task, then marks it caught up.
 * Only other people's (and Kunla's) changes on work it holds, held or filed, plus new rules and focus.
 */
export async function sinceLastSession(c: Ctx): Promise<CatchUp | null> {
  if (c.me?.kind !== 'ai') return null;
  const at = now(c).toISOString();
  const row = await c.db.prepare('SELECT seen_at FROM members WHERE id = ?').bind(c.me.id).first<{ seen_at: string | null }>();
  const since = row?.seen_at ?? null;
  await c.db.prepare('UPDATE members SET seen_at = ? WHERE id = ?').bind(at, c.me.id).run();
  if (!since) return { since: null, first_session: true, count: 0, items: [], note: 'First session: from now on, whoami and next_task tell you what changed for you since you last called.' };
  const rows = (await c.db.prepare(
    `SELECT e.type, e.note, e.data, e.created_at, e.actor_id, m.name AS actor, t.key, t.title, t.assignee_id, t.created_by,
            p.key AS project_key
     FROM events e LEFT JOIN tasks t ON t.id = e.task_id LEFT JOIN members m ON m.id = e.actor_id
     LEFT JOIN projects p ON p.id = t.project_id
     WHERE e.space_id = ? AND e.created_at > ? AND e.created_at <= ? AND (e.actor_id IS NULL OR e.actor_id != ?)
       AND e.type IN (${TYPES.map(() => '?').join(',')})
     ORDER BY e.id DESC LIMIT 200`).bind(c.space, since, at, c.me.id, ...TYPES).all<Row>()).results;
  const me = c.me.id;
  const items: CatchUpItem[] = [];
  for (const r of rows) {
    const d = parse(r.data);
    if (d.via?.agent_id === me) continue; // a decision it recorded itself; it already knows
    const team = ['rule_added', 'focus_on', 'focus_off'].includes(r.type);
    const mine = r.assignee_id === me || r.created_by === me || d.to === me || d.previous === me || d.previous_assignee === me;
    if (!team && !mine) continue;
    const l = line(r, me);
    if (!l) continue;
    items.push({ what: r.type, key: r.key, title: r.title, line: l, by: r.actor, at: r.created_at });
    if (items.length >= MAX_ITEMS) break;
  }
  return {
    since, first_session: false, count: items.length, items,
    note: items.length ? 'Changes since you last called, newest first. Act on answers and sent-back work before taking new tasks; get_task KEY has the details.' : 'Nothing changed for you since you last called.',
  };
}
