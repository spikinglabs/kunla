import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';
import { makeD1 } from './d1-shim';
import { mentions, normalizeRepo, repoOf, guessForge } from '../src/refs';
import { linkType } from '../src/kinds';

// KD-42: PR/MR and issue mentions in briefs become links, on whatever code host the project uses.
describe('mentions', () => {
  const urls = (text: string, repo?: any) => mentions(text, repo).map((m) => m.url);

  it('reads the SB-5 brief: owner/repo PR #N', () => {
    const m = mentions('emptymalei/probabilistic-minimal-preproduction-kit PR #3 (opened 2026-11-02) adds related work.');
    expect(m).toEqual([{ url: 'https://github.com/emptymalei/probabilistic-minimal-preproduction-kit/pull/3', title: 'emptymalei/probabilistic-minimal-preproduction-kit PR #3', type: 'pr', text: 'emptymalei/probabilistic-minimal-preproduction-kit PR #3' }]);
  });

  it('reads owner/repo#N, issues, GitLab !N and full URLs on any host, once each', () => {
    expect(urls('See acme/site#12 and acme/site issue 4.')).toEqual(['https://github.com/acme/site/issues/12', 'https://github.com/acme/site/issues/4']);
    expect(urls('group/sub/app!7 is the MR')).toEqual(['https://gitlab.com/group/sub/app/-/merge_requests/7']);
    expect(urls('https://gitlab.acme.com/team/app/-/merge_requests/9, https://git.corp.com/a/b/pull/3 and https://github.com/x/y/pull/1 plus x/y#1'))
      .toEqual(['https://gitlab.acme.com/team/app/-/merge_requests/9', 'https://git.corp.com/a/b/pull/3', 'https://github.com/x/y/pull/1', 'https://github.com/x/y/issues/1']);
    expect(urls('https://bitbucket.org/team/repo/pull-requests/5')).toEqual(['https://bitbucket.org/team/repo/pull-requests/5']);
  });

  it('uses the project repo for host and short forms', () => {
    const gl = repoOf('git@gitlab.acme.com:team/app.git');
    expect(gl).toEqual({ base: 'https://gitlab.acme.com', path: 'team/app', forge: 'gitlab' });
    expect(urls('Finish PR #3, then !4, and issue #5; other/lib#6 too.', gl)).toEqual([
      'https://gitlab.acme.com/team/app/-/merge_requests/3', 'https://gitlab.acme.com/team/app/-/merge_requests/4',
      'https://gitlab.acme.com/team/app/-/issues/5', 'https://gitlab.acme.com/other/lib/-/issues/6']);
    const ghe = repoOf('https://github.acme.com/eng/api', null);
    expect(urls('PR #8', ghe)).toEqual(['https://github.acme.com/eng/api/pull/8']);
    // A neutral host name is read as GitLab unless the project says which.
    expect(repoOf('https://git.acme.com/eng/api')!.forge).toBe('gitlab');
    expect(urls('PR #8', repoOf('https://git.acme.com/eng/api', 'gitea'))).toEqual(['https://git.acme.com/eng/api/pull/8']);
    // Without a repo, bare "PR #3" and "!3" are not guessed.
    expect(urls('PR #3 and wow!3')).toEqual([]);
  });

  it('leaves ordinary text alone', () => {
    expect(urls('Priority #1 for Q3, 50/50 split, see docs/readme.md, and/or later, 2026/11 #3')).toEqual([]);
  });

  it('normalizes remotes and labels links on any host', () => {
    expect(normalizeRepo('git@github.com:acme/site.git')).toBe('https://github.com/acme/site');
    expect(normalizeRepo('ssh://git@gitlab.acme.com:2222/team/sub/app.git')).toBe('https://gitlab.acme.com/team/sub/app');
    expect(normalizeRepo('https://gitlab.com/team/app/')).toBe('https://gitlab.com/team/app');
    expect(normalizeRepo('not a repo')).toBeNull();
    expect(guessForge('https://codeberg.org/a/b')).toBe('gitea');
    expect(linkType('https://gitlab.acme.com/team/app/-/merge_requests/9')).toBe('pr');
    expect(linkType('https://github.acme.com/eng/api/pull/8')).toBe('pr');
  });
});

let env: any;
const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const res = await app.fetch(new Request(`https://kunla.test${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const tool = async (token: string, name: string, args: unknown = {}) => {
  const r = (await call('POST', '/mcp', token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).body;
  const text = r.result.content[0].text;
  return { isError: r.result.isError, data: r.result.isError ? text : JSON.parse(text) };
};
let human: string, ai: string;

beforeEach(async () => {
  env = { DB: makeD1(), LEASE_MINUTES: '30' };
  human = (await call('POST', '/api/setup', undefined, { name: 'L', project_key: 'SB', project_name: 'Symbola' })).body.token;
  ai = (await call('POST', '/api/members', human, { name: "L's Claude", kind: 'ai' })).body.token;
});

describe('mentions on tasks', () => {
  it('shows mentions on proposals and the task, but never as deliverables', async () => {
    const t = (await tool(ai, 'create_task', { project: 'SB', title: 'Finish the kit paper housekeeping PR', brief: 'emptymalei/kit PR #3 tidies the paper; review and merge or close.' })).data;
    const inbox = (await call('GET', '/api/inbox', human)).body;
    const card = inbox.items.find((i: any) => i.task.key === t.key);
    expect(card.kind).toBe('proposal');
    expect(card.task.mentions[0].url).toBe('https://github.com/emptymalei/kit/pull/3');
    const d = (await call('GET', `/api/tasks/${t.key}`, human)).body;
    expect(d.mentions.map((m: any) => m.url)).toEqual(['https://github.com/emptymalei/kit/pull/3']);
    expect(d.deliverables).toEqual([]);
  });

  it('remembers the repo an agent reports, and people can change it', async () => {
    const t = (await tool(ai, 'create_task', { project: 'SB', title: 'Fix the login bug', brief: 'Follow up on PR #12.', repo: 'git@gitlab.acme.com:team/app.git' })).data;
    expect((await call('GET', '/api/projects/SB', human)).body.repo_url).toBe('https://gitlab.acme.com/team/app');
    let d = (await call('GET', `/api/tasks/${t.key}`, human)).body;
    expect(d.mentions.map((m: any) => m.url)).toEqual(['https://gitlab.acme.com/team/app/-/merge_requests/12']);
    expect(d.repo).toBe('https://gitlab.acme.com/team/app');
    // A later report doesn't overwrite it.
    await tool(ai, 'log_work', { task: t.key, summary: 'Looked at it', repo: 'https://github.com/other/repo' });
    expect((await call('GET', '/api/projects/SB', human)).body.repo_url).toBe('https://gitlab.acme.com/team/app');
    // A person changes it on the Projects page.
    expect((await call('PATCH', '/api/projects/SB', human, { repo_url: 'https://git.acme.com/team/app', repo_forge: 'gitea' })).status).toBe(200);
    d = (await call('GET', `/api/tasks/${t.key}`, human)).body;
    expect(d.mentions.map((m: any) => m.url)).toEqual(['https://git.acme.com/team/app/pull/12']);
    expect((await call('PATCH', '/api/projects/SB', human, { repo_url: 'nope' })).status).toBe(400);
  });

  it('records a kind change in the history', async () => {
    const t = (await tool(ai, 'create_task', { project: 'SB', title: 'Tidy the paper', kind: 'writing' })).data;
    await call('PATCH', `/api/tasks/${t.key}`, human, { kind: 'code' });
    const d = (await call('GET', `/api/tasks/${t.key}`, human)).body;
    const e = d.history.find((x: any) => x.data?.kind);
    expect(e.note).toBe('Kind: Writing → Code');
  });
});
