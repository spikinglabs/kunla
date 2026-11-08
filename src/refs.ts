// Pull/merge requests and issues a brief or summary mentions (KD-42), so they show as links instead
// of plain text. Works for GitHub, GitHub Enterprise, GitLab (gitlab.com and self-managed), Gitea,
// Forgejo and Bitbucket. Full URLs work on any host; short forms ("acme/site#12", "PR #12", "!12")
// are resolved against the project's repository, which a person sets on the Projects page or an
// agent reports from `git remote get-url origin`.
// Mentions are not deliverables: approving a task never merges a PR it only mentions.

export type Forge = 'github' | 'gitlab' | 'gitea' | 'bitbucket';
export const FORGES: Forge[] = ['github', 'gitlab', 'gitea', 'bitbucket'];
export interface Repo { base: string; path: string; forge: Forge } // base "https://host", path "group/project"
export interface Mention { url: string; title: string; type: 'pr' | 'issue'; text: string }

/** A git remote or repository URL as https://host/path, or null. Accepts https, ssh:// and scp-style git@host:path. */
export function normalizeRepo(remote: string | null | undefined): string | null {
  let s = String(remote ?? '').trim();
  if (!s) return null;
  const scp = s.match(/^[\w.-]+@([^:/\s]+):(?!\d+\/)(.+)$/); // git@host:group/proj.git
  if (scp) s = `https://${scp[1]}/${scp[2]}`;
  let u: URL;
  try { u = new URL(s.replace(/^(ssh|git|git\+ssh|ssh\+git):\/\//i, 'https://')); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.') && u.hostname !== 'localhost') return null;
  const path = u.pathname.replace(/\.git$/i, '').replace(/\/+$/, '').replace(/^\/+/, '');
  if (!path.includes('/')) return null;
  // Over ssh the port is ssh's, not the web's.
  const port = /^https?:/i.test(s) && u.port ? `:${u.port}` : '';
  return `${/^http:/i.test(s) ? 'http' : 'https'}://${u.hostname.toLowerCase()}${port}/${path}`;
}

/** Which code host a URL is on, from its name. Self-managed hosts with neutral names (git.acme.com) are GitLab unless the project says otherwise. */
export function guessForge(url: string): Forge {
  let h = '';
  try { h = new URL(url).hostname.toLowerCase(); } catch { return 'github'; }
  if (h === 'github.com' || /(^|[.-])github([.-]|$)/.test(h) || h.endsWith('.ghe.com')) return 'github';
  if (h === 'bitbucket.org' || /(^|[.-])bitbucket([.-]|$)/.test(h)) return 'bitbucket';
  if (h === 'codeberg.org' || /(^|[.-])(gitea|forgejo)([.-]|$)/.test(h)) return 'gitea';
  return 'gitlab';
}

/** The project's repository, from its stored URL and (optional) forge. */
export function repoOf(url: string | null | undefined, forge?: string | null): Repo | null {
  const n = normalizeRepo(url);
  if (!n) return null;
  const u = new URL(n);
  return { base: u.origin, path: u.pathname.slice(1), forge: FORGES.includes(forge as Forge) ? forge as Forge : guessForge(n) };
}

/** Link to a PR/MR or issue on a forge. */
export function forgeLink(base: string, path: string, forge: Forge, type: 'pr' | 'issue', n: string | number): string {
  const seg = forge === 'gitlab' ? (type === 'pr' ? '-/merge_requests' : '-/issues')
    : forge === 'bitbucket' ? (type === 'pr' ? 'pull-requests' : 'issues')
    : type === 'pr' ? 'pull' : 'issues';
  return `${base}/${path}/${seg}/${n}`;
}

const prWord = (forge: Forge) => (forge === 'gitlab' ? 'MR' : 'PR');
const sign = (forge: Forge, type: 'pr' | 'issue') => (forge === 'gitlab' && type === 'pr' ? '!' : '#');

// A PR/MR or issue page on any host: GitHub/GHE/Gitea (/pull/N), GitLab (/-/merge_requests/N), Bitbucket (/pull-requests/N).
const PAGE = /^(https?:\/\/[^/\s]+)\/((?:[^/\s]+\/)+?[^/\s]+?)\/(?:-\/)?(pull|pulls|merge_requests|pull-requests|issues)\/(\d+)(?=$|[/?#])/;
const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
const clean = (u: string) => u.replace(/[.,;:!?)\]]+$/, '');

/** What a URL points to when it is a PR/MR or issue page on a code host, else null. */
export function forgePage(url: string): { url: string; title: string; type: 'pr' | 'issue' } | null {
  const m = clean(url).match(PAGE);
  if (!m) return null;
  const type = m[3] === 'issues' ? 'issue' : 'pr';
  const forge = m[3] === 'merge_requests' ? 'gitlab' : m[3] === 'pull-requests' ? 'bitbucket' : guessForge(m[1]);
  return { url: clean(url), title: `${m[2]} ${type === 'pr' ? prWord(forge) : 'issue'} ${sign(forge, type)}${m[4]}`, type };
}

const PATH = '[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})(?:\\/[A-Za-z0-9._-]{1,100}){1,4}';
// "acme/site#12", "acme/site!12" (GitLab MR), "acme/site PR #12", "group/sub/proj MR !12", "acme/site issue 12".
const QUALIFIED = new RegExp(`(?<![\\w./:@-])(${PATH})(?:([#!])|\\s+(PR|MR|pull request|merge request|pull|issue)\\s*([#!])?)(\\d+)\\b`, 'gi');
// Without a repo, only when the project has one: "PR #12", "MR !12", "pull request #12", "issue #12", "!12".
const BARE = /(?<![\w/#!-])(?:(PR|MR|pull request|merge request|issue)\s*([#!])|(!))(\d+)\b/gi;

/**
 * The PRs/MRs and issues a piece of text mentions, as links, first mention first, no repeats.
 * `repo` is the project's repository; without one, short forms are read as GitHub ("!12" as GitLab).
 */
export function mentions(text: string | null | undefined, repo?: Repo | null): Mention[] {
  const s = String(text ?? '');
  const found: (Mention & { at: number })[] = [];
  const seen = new Set<string>();
  const add = (at: number, m: Omit<Mention, 'text'>, txt: string) => {
    const id = m.url.toLowerCase();
    if (seen.has(id)) return;
    seen.add(id);
    found.push({ ...m, text: txt, at });
  };
  // Full URLs first; blank them out so their parts aren't read again as short forms.
  let rest = s;
  for (const m of s.matchAll(URL_RE)) {
    const page = forgePage(m[0]);
    if (page) add(m.index!, page, clean(m[0]));
    rest = rest.slice(0, m.index!) + ' '.repeat(m[0].length) + rest.slice(m.index! + m[0].length);
  }
  const taken: [number, number][] = [];
  for (const m of rest.matchAll(QUALIFIED)) {
    const [txt, path, sym1, word, sym2, n] = m;
    const w = (word || '').toLowerCase();
    const sym = sym1 || sym2 || '';
    const saysMr = sym === '!' || w === 'mr' || w === 'merge request';
    // Same host as the project's repo, or gitlab.com for an MR, else github.com.
    const forge: Forge = repo ? repo.forge : saysMr ? 'gitlab' : 'github';
    const base = repo ? repo.base : forge === 'gitlab' ? 'https://gitlab.com' : 'https://github.com';
    const type: 'pr' | 'issue' = w === 'issue' ? 'issue' : saysMr || w ? 'pr' : 'issue';
    // "acme/site#12" on GitHub: /issues/12 redirects to the PR when it is one.
    const p = path.replace(/\.git$/i, '');
    add(m.index!, { url: forgeLink(base, p, forge, type, n), title: `${p} ${type === 'pr' ? prWord(forge) : 'issue'} ${sign(forge, type)}${n}`, type }, txt);
    taken.push([m.index!, m.index! + txt.length]);
  }
  if (repo) {
    for (const m of rest.matchAll(BARE)) {
      if (taken.some(([a, b]) => m.index! >= a && m.index! < b)) continue;
      const [txt, word, , bang, n] = m;
      const w = (word || '').toLowerCase();
      const type: 'pr' | 'issue' = w === 'issue' ? 'issue' : 'pr';
      if (bang && repo.forge !== 'gitlab') continue; // "!12" means an MR only on GitLab
      add(m.index!, { url: forgeLink(repo.base, repo.path, repo.forge, type, n), title: `${repo.path} ${type === 'pr' ? prWord(repo.forge) : 'issue'} ${sign(repo.forge, type)}${n}`, type }, txt);
    }
  }
  return found.sort((a, b) => a.at - b.at).map(({ at: _at, ...m }) => m);
}
