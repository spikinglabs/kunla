// Plug-in points (KD-75). The Apache-2.0 core never imports ee/: enterprise code imports the core and registers
// what it adds here, from its own Worker entry (ee/worker.ts, pointed at by `main` in wrangler.toml). Each
// extension names the licence feature it needs and only runs when the licence has it. With nothing registered
// (every Community Kunla) these hooks cost nothing.
import type { Ctx, Member } from './core';
import type { Licence } from './licence';

/** Something a person or agent is about to do that a company policy may refuse. */
export type PolicyAction =
  | { type: 'add_member'; kind: 'human' | 'ai'; name: string; platform?: string | null }
  | { type: 'claim_task'; task: { key: string; kind?: string | null; project_id: string } }
  | { type: 'create_workspace'; name: string };

export interface Policy {
  name: string;
  feature: string;                 // licence feature that turns it on, e.g. "policies"
  /** null allows; a sentence refuses, and is shown to whoever tried. */
  check(c: Ctx, action: PolicyAction, licence: Licence): Promise<string | null> | string | null;
}

/** One row of the record, as an audit sink receives it. */
export interface AuditEvent {
  id: number; space_id: string; task_key: string | null; actor: string | null; actor_kind: string | null;
  type: string; note: string | null; data: string; created_at: string;
}

export interface AuditSink {
  name: string;
  feature: string;                 // e.g. "audit"
  /** Ships a batch of events (oldest first) to the company's log tools; throw to retry the same batch next time. */
  send(events: AuditEvent[], env: Record<string, unknown>): Promise<void>;
}

/** A way for people to sign in (OIDC, SAML, ...). Its routes live under /auth/<id>/... */
export interface SignInProvider {
  id: string;                      // e.g. "okta"; routes are /auth/okta/*
  label: string;                   // "Sign in with Okta"
  feature: string;                 // e.g. "sso"
  /** Handles /auth/<id>/<rest>. Returns the member to sign in (Kunla issues the token), or a Response to send. */
  handle(req: Request, rest: string, env: Record<string, unknown>, db: D1Database): Promise<Member | Response>;
}

export interface Extensions {
  policies: Policy[];
  audit: AuditSink[];
  signIn: SignInProvider[];
}

const registry: Extensions = { policies: [], audit: [], signIn: [] };

export function register(ext: Partial<Extensions>) {
  registry.policies.push(...(ext.policies ?? []));
  registry.audit.push(...(ext.audit ?? []));
  registry.signIn.push(...(ext.signIn ?? []));
}

/** For tests: forget everything registered. */
export function reset() { registry.policies = []; registry.audit = []; registry.signIn = []; }

export const extensions = (): Readonly<Extensions> => registry;

/** The first policy (with its feature licensed) that refuses the action, or null. */
export async function refusal(c: Ctx, action: PolicyAction, licence: Licence): Promise<string | null> {
  for (const p of registry.policies) {
    if (licence.edition !== 'enterprise' || !licence.features.includes(p.feature)) continue;
    const why = await p.check(c, action, licence);
    if (why) return why;
  }
  return null;
}

/**
 * Sends events recorded since the last run to each licensed audit sink. Called from the cron; the cursor per sink
 * lives in settings (audit_cursor:<name>), so a failed send is retried from the same place next time.
 */
export async function flushAudit(db: D1Database, env: Record<string, unknown>, licence: Licence, batch = 500) {
  for (const sink of registry.audit) {
    if (licence.edition !== 'enterprise' || !licence.features.includes(sink.feature)) continue;
    const key = `audit_cursor:${sink.name}`;
    const cursor = Number((await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>())?.value ?? 0);
    const rows = (await db.prepare(
      `SELECT e.id, e.space_id, t.key AS task_key, m.name AS actor, m.kind AS actor_kind, e.type, e.note, e.data, e.created_at
       FROM events e LEFT JOIN tasks t ON t.id = e.task_id LEFT JOIN members m ON m.id = e.actor_id
       WHERE e.id > ? ORDER BY e.id LIMIT ?`).bind(cursor, batch).all<AuditEvent>()).results;
    if (!rows.length) continue;
    try {
      await sink.send(rows, env);
    } catch (e) {
      console.error(`audit sink ${sink.name} failed`, e);
      continue;
    }
    await db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .bind(key, String(rows[rows.length - 1].id), new Date().toISOString()).run();
  }
}
