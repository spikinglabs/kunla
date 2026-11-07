// Test helper: a Kunla GitHub App already registered, with installations linked to workspaces.
import { generateKeyPairSync } from 'node:crypto';

export const APP_SECRET = 'whsec';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const APP_PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

export async function linkApp(db: D1Database, installs: Record<number, string> = { 42: 'workspace' }, merge = true) {
  const now = new Date().toISOString();
  const app = { id: 99, slug: 'kunla-acme', name: 'Kunla acme', pem: APP_PEM, webhook_secret: APP_SECRET, html_url: 'https://github.com/apps/kunla-acme', owner: 'acme', owner_is_org: true, merge, created_at: now };
  await db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)').bind('github_app', JSON.stringify(app), now).run();
  for (const [id, space] of Object.entries(installs))
    await db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)').bind(`github_installation:${id}`, JSON.stringify({ space, account: 'acme', account_is_org: true }), now).run();
}
