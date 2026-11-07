import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';
import { makeD1 } from './d1-shim';
import { findKeys, nextStatus, sign, verifySignature } from '../src/github';

let env: any;
let human: string;
let secret: string;

const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const res = await app.fetch(new Request(`https://kunla.test${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

let delivery = 0;
const hook = async (event: string, payload: unknown, opts: { secret?: string; signature?: string; delivery?: string } = {}) => {
  const body = JSON.stringify(payload);
  const res = await app.fetch(new Request('https://kunla.test/hooks/github', {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': opts.delivery ?? `d-${++delivery}`,
      'x-hub-signature-256': opts.signature ?? (await sign(opts.secret ?? secret, body)),
    },
    body,
  }), env);
  return { status: res.status, body: await res.json<any>() };
};

const pr = (action: string, over: Record<string, unknown> = {}, prOver: Record<string, unknown> = {}) => ({
  action,
  pull_request: {
    number: 7, html_url: 'https://github.com/acme/app/pull/7', title: 'MKT-1: Pricing page', body: '', draft: false, merged: false,
    head: { ref: 'mkt-1-pricing-page' }, user: { login: 'octo' }, ...prOver,
  },
  ...over,
});

const task = async (key: string) => (await call('GET', `/api/tasks/${key}`, human)).body;

beforeEach(async () => {
  env = { DB: makeD1(), LEASE_MINUTES: '30' };
  const s = await call('POST', '/api/setup', undefined, { name: 'L', project_key: 'MKT', project_name: 'Q1 campaign' });
  human = s.body.token;
  await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Pricing page' });       // MKT-1
  await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Launch email' });       // MKT-2
  const g = await call('POST', '/api/integrations/github', human);
  expect(g.status).toBe(200);
  secret = g.body.secret;
});

describe('signature', () => {
  it('accepts only a matching X-Hub-Signature-256', async () => {
    const sig = await sign('s3cret', '{"a":1}');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(await verifySignature(['s3cret'], '{"a":1}', sig)).toBe(true);
    expect(await verifySignature(['other', 's3cret'], '{"a":1}', sig)).toBe(true);
    expect(await verifySignature(['s3cret'], '{"a":2}', sig)).toBe(false);
    expect(await verifySignature(['s3cret'], '{"a":1}', null)).toBe(false);
    expect(await verifySignature(['s3cret'], '{"a":1}', 'sha1=abc')).toBe(false);
  });
  it('rejects deliveries signed with the wrong secret, and replaced secrets', async () => {
    expect((await hook('ping', {}, { secret: 'wrong' })).status).toBe(401);
    expect((await hook('ping', {}, { signature: 'sha256=00' })).status).toBe(401);
    expect((await hook('ping', {})).body).toMatchObject({ pong: true });
    const old = secret;
    secret = (await call('POST', '/api/integrations/github', human)).body.secret;
    expect((await hook('ping', {}, { secret: old })).status).toBe(401);
    expect((await hook('ping', {})).status).toBe(200);
  });
  it('says GitHub is not connected when there is no secret, and accepts an env secret', async () => {
    env = { DB: makeD1() };
    expect((await hook('ping', {}, { secret: 'x' })).status).toBe(503);
    env = { DB: makeD1(), GITHUB_WEBHOOK_SECRET: 'from-env' };
    expect((await hook('ping', {}, { secret: 'from-env' })).status).toBe(200);
  });
  it('lets only admins create the secret', async () => {
    const a = await call('POST', '/api/members', human, { name: 'Bot', kind: 'ai' });
    expect((await call('POST', '/api/integrations/github', a.body.token)).status).toBe(403);
    const info = await call('GET', '/api/integrations/github', human);
    expect(info.body).toMatchObject({ webhook_url: 'https://kunla.test/hooks/github', events: ['pull_request', 'push', 'check_suite'], secret_set: true });
    expect(info.body.secret).toBeUndefined();
  });
});

describe('key parsing', () => {
  it('finds keys in titles, lower-case branches, bodies and trailers', () => {
    expect(findKeys('KD-12: Fix x', 'kd-3-update-tasks', 'Closes KD-4 and (KD-5).', 'Task: KD-12 https://k/t/KD-12')).toEqual(['KD-12', 'KD-3', 'KD-4', 'KD-5']);
  });
  it('ignores things that only look like keys', () => {
    expect(findKeys('1KD-1', 'KD-1x', 'K-1', 'claude/project-thread-tejr86')).toEqual([]);
    expect(findKeys('KD-007')).toEqual(['KD-7']);
  });
});

describe('status transitions', () => {
  it('moves forward only', () => {
    expect(nextStatus('ready', 'opened', true)).toBe('review');
    expect(nextStatus('in_progress', 'opened', false)).toBe('review');
    expect(nextStatus('blocked', 'opened', true)).toBeNull();
    expect(nextStatus('done', 'opened', true)).toBeNull();
    expect(nextStatus('inbox', 'opened', true)).toBeNull();
    expect(nextStatus('ready', 'draft', true)).toBe('in_progress');
    expect(nextStatus('review', 'merged', false)).toBe('done');
    expect(nextStatus('review', 'merged', true)).toBeNull();
    expect(nextStatus('in_progress', 'merged', true)).toBe('review');
    expect(nextStatus('in_progress', 'closed', false)).toBeNull();
  });
});

describe('pull requests', () => {
  it('links an opened PR, sends it to review, and a merge waits for a person when the project requires one', async () => {
    const r = await hook('pull_request', pr('opened'));
    expect(r.body.updated).toEqual([{ key: 'MKT-1', from: 'ready', to: 'review' }]);
    let t = await task('MKT-1');
    expect(t.status).toBe('review');
    expect(t.deliverables[0]).toMatchObject({ url: 'https://github.com/acme/app/pull/7', title: 'PR #7: MKT-1: Pricing page' });
    expect(t.history[0]).toMatchObject({ type: 'github', actor: null });
    expect(t.history[0].note).toContain('PR #7 opened by @octo');

    await hook('pull_request', pr('closed', {}, { merged: true }));
    t = await task('MKT-1');
    expect(t.status).toBe('review'); // MKT requires human review by default
    expect(t.history[0].note).toContain("merged; waiting for a person's review");
    expect(t.deliverables).toHaveLength(1);
  });

  it('closes the task on merge when the project does not require human review, and rolls up the parent', async () => {
    await call('PATCH', '/api/projects/MKT', human, { require_human_review: false });
    await call('POST', '/api/tasks', human, { parent: 'MKT-2', title: 'Write subject line' }); // MKT-3
    await hook('pull_request', pr('closed', {}, { merged: true, title: 'MKT-3 subject line', head: { ref: 'x' } }));
    expect((await task('MKT-3')).status).toBe('done');
    expect((await task('MKT-2')).status).toBe('done');
  });

  it('does not finish a parent on merge while it has open sub-tasks', async () => {
    await call('PATCH', '/api/projects/MKT', human, { require_human_review: false });
    await call('POST', '/api/tasks', human, { parent: 'MKT-1', title: 'Connect the repo' }); // MKT-3
    await hook('pull_request', pr('closed', {}, { merged: true }));
    const t = await task('MKT-1');
    expect(t.status).toBe('ready');
    expect(t.history[0].note).toContain('MKT-1 finishes when MKT-3 is done');
  });

  it('keeps drafts in progress and ignores PRs closed without merging', async () => {
    await hook('pull_request', pr('opened', {}, { draft: true }));
    expect((await task('MKT-1')).status).toBe('in_progress');
    await hook('pull_request', pr('closed'));
    const t = await task('MKT-1');
    expect(t.status).toBe('in_progress');
    expect(t.history[0].note).toContain('closed without merging');
  });

  it('picks up a key added later by an edit, once, and skips unknown keys', async () => {
    await hook('pull_request', pr('opened', {}, { title: 'Pricing page', head: { ref: 'pricing' }, body: 'See NOPE-9' }));
    expect((await task('MKT-1')).status).toBe('ready');
    await hook('pull_request', pr('edited', {}, { title: 'Pricing page', head: { ref: 'pricing' }, body: 'Fixes MKT-2' }));
    expect((await task('MKT-2')).status).toBe('review');
    const before = (await task('MKT-2')).history.length;
    await hook('pull_request', pr('synchronize', {}, { title: 'Pricing page', head: { ref: 'pricing' }, body: 'Fixes MKT-2' }));
    expect((await task('MKT-2')).history.length).toBe(before);
  });

  it('counts a redelivered event once', async () => {
    await hook('pull_request', pr('opened'), { delivery: 'same' });
    const again = await hook('pull_request', pr('opened'), { delivery: 'same' });
    expect(again.body).toMatchObject({ duplicate: true });
    expect((await task('MKT-1')).history.filter((e: any) => e.type === 'github')).toHaveLength(1);
  });
});

describe('pushes', () => {
  it('records each new commit that cites a task in its history', async () => {
    const r = await hook('push', {
      ref: 'refs/heads/mkt-1-pricing',
      commits: [
        { id: 'abcdef1234567', message: 'Add tiers\n\nTask: MKT-1 https://kunla.test/t/MKT-1', url: 'https://github.com/acme/app/commit/abcdef1', distinct: true, author: { username: 'octo' } },
        { id: 'fff0000', message: 'MKT-1 again (already seen)', url: 'https://x', distinct: false },
        { id: '1234567', message: 'Unrelated', url: 'https://y', distinct: true },
      ],
    });
    expect(r.body.linked).toEqual(['MKT-1']);
    const t = await task('MKT-1');
    const gh = t.history.filter((e: any) => e.type === 'github');
    expect(gh).toHaveLength(1);
    expect(gh[0].note).toBe('Commit abcdef1 on mkt-1-pricing by @octo: Add tiers');
    expect(t.status).toBe('ready');
  });
  it('ignores other events', async () => {
    expect((await hook('issues', { action: 'opened' })).status).toBe(202);
  });
});

describe('webhooks with several workspaces', () => {
  it('routes each delivery to the workspace whose secret signed it', async () => {
    const ws = (await call('POST', '/api/workspaces', human, { name: 'Community', key: 'COM' })).body;
    await call('POST', '/api/tasks', ws.token, { title: 'Meetup venue' });                     // COM-1
    const other = (await call('POST', '/api/integrations/github', ws.token)).body.secret;
    expect(other).not.toBe(secret);
    // The Community secret can't touch MKT tasks, and the first workspace's secret can't touch COM tasks.
    const a = await hook('pull_request', pr('opened', {}, { title: 'MKT-1 and COM-1', head: { ref: 'x' } }), { secret: other });
    expect(a.body.updated.map((u: any) => u.key)).toEqual(['COM-1']);
    const b = await hook('pull_request', pr('opened', {}, { number: 8, html_url: 'https://github.com/acme/app/pull/8', title: 'MKT-2 and COM-1', head: { ref: 'y' } }));
    expect(b.body.updated.map((u: any) => u.key)).toEqual(['MKT-2']);
    expect((await call('GET', '/api/tasks/COM-1', ws.token)).body.status).toBe('review');
    // Each workspace only sees its own last delivery and its own secret.
    expect((await call('GET', '/api/integrations/github', ws.token)).body.secret_set).toBe(true);
  });
});
