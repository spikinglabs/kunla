#!/usr/bin/env node
// Kunla release notes and version bumps (KD-64).
//
//   node scripts/changelog.mjs notes [FROM] [TO]   print release notes for FROM..TO (default: last v* tag..HEAD)
//   node scripts/changelog.mjs section VERSION     print the CHANGELOG.md section for VERSION (empty if none)
//   node scripts/changelog.mjs prepare VERSION     set VERSION everywhere and add its section to CHANGELOG.md
//
// Notes come from the pull requests merged into main (first-parent history), so they read like the PR titles,
// which in this repo start with the Kunla task keys they cover ("KD-82: Filter Tasks by project (#51)").
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const REPO = 'https://github.com/spikinglabs/kunla';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

export function lastTag(ref = 'HEAD') {
  try { return git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', ref); } catch { return ''; }
}

/** One entry per first-parent commit: { title, pr, keys }. */
export function entries(from, to = 'HEAD') {
  const range = from ? `${from}..${to}` : to;
  const raw = git('log', '--first-parent', '--format=%s%x1f%b%x1e', range);
  const out = [];
  for (const rec of raw.split('\x1e')) {
    if (!rec.trim()) continue;
    const [subject, body = ''] = rec.trim().split('\x1f');
    out.push(parseCommit(subject, body));
  }
  return out.filter((e) => e && !/^release v?\d/i.test(e.title));
}

export function parseCommit(subject, body = '') {
  let title = subject.trim();
  let pr = null;
  const merge = title.match(/^Merge pull request #(\d+) from \S+/);
  if (merge) {
    pr = Number(merge[1]);
    title = body.split('\n').map((l) => l.trim()).find(Boolean) || title;
  }
  const squash = title.match(/\s*\(#(\d+)\)$/);
  if (squash) { pr = pr ?? Number(squash[1]); title = title.slice(0, squash.index).trim(); }
  const keys = [...new Set(title.match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g) || [])];
  return { title, pr, keys };
}

export function renderNotes(list, repo = REPO) {
  if (!list.length) return '- No changes.';
  return list
    .map((e) => `- ${e.title}${e.pr ? ` ([#${e.pr}](${repo}/pull/${e.pr}))` : ''}`)
    .join('\n');
}

export function section(changelog, version) {
  const re = new RegExp(`^## \\[?v?${version.replace(/\./g, '\\.')}\\]?[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm');
  const m = changelog.match(re);
  return m ? m[1].trim() : '';
}

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const FILES = [
  ['package.json', (s, v) => s.replace(/("version":\s*")[^"]+(")/, `$1${v}$2`)],
  ['src/version.ts', (s, v) => s.replace(/(VERSION = ')[^']+(')/, `$1${v}$2`)],
  ['plugins/claude-code/.claude-plugin/plugin.json', (s, v) => s.replace(/("version":\s*")[^"]+(")/, `$1${v}$2`)],
];

function prepare(version) {
  if (!SEMVER.test(version)) throw new Error(`Not a version: ${version} (use 1.2.3)`);
  for (const [file, edit] of FILES) {
    const before = readFileSync(file, 'utf8');
    writeFileSync(file, edit(before, version));
  }
  const header = '# Changelog\n\nWhat changed in each Kunla release. Upgrading a self-hosted copy: see the README.\n';
  const current = existsSync('CHANGELOG.md') ? readFileSync('CHANGELOG.md', 'utf8') : header;
  if (section(current, version)) { console.log(`CHANGELOG.md already has ${version}`); return; }
  const date = new Date().toISOString().slice(0, 10);
  const notes = renderNotes(entries(lastTag()));
  const body = current.startsWith('# Changelog') ? current.replace(/^# Changelog[\s\S]*?(?=^## |(?![\s\S]))/m, '') : current;
  writeFileSync('CHANGELOG.md', `${header}\n## ${version} (${date})\n\n${notes}\n\n${body.trim() ? body.trim() + '\n' : ''}`);
  console.log(`Set version ${version} and added it to CHANGELOG.md. Edit the notes if you like, then open a PR titled "Release v${version}".`);
}

const [cmd, a, b] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (cmd === 'notes') console.log(renderNotes(entries(a ?? lastTag(), b ?? 'HEAD')));
  else if (cmd === 'section') console.log(section(readFileSync('CHANGELOG.md', 'utf8'), a));
  else if (cmd === 'prepare') prepare(a);
  else { console.error('Usage: changelog.mjs notes [FROM] [TO] | section VERSION | prepare VERSION'); process.exit(1); }
}
