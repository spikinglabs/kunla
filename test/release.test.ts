// KD-64: release notes from merged PRs, and one version everywhere.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { VERSION } from '../src/version';
import { SERVER_INFO } from '../src/mcp';

const script = '../scripts/changelog.mjs';
const load = () => import(/* @vite-ignore */ script as string) as Promise<any>;

describe('release notes', () => {
  it('reads squash and merge commits', async () => {
    const { parseCommit } = await load();
    expect(parseCommit('KD-82: Filter Tasks by project (#51)')).toEqual({ title: 'KD-82: Filter Tasks by project', pr: 51, keys: ['KD-82'] });
    expect(parseCommit('Merge pull request #52 from spikinglabs/kd-83-x', '\nKD-83: Claim the name\n')).toEqual({ title: 'KD-83: Claim the name', pr: 52, keys: ['KD-83'] });
    expect(parseCommit('KD-48: Standup (KD-49, KD-50) (#43)').keys).toEqual(['KD-48', 'KD-49', 'KD-50']);
    expect(parseCommit('Fix a typo').pr).toBeNull();
  });

  it('renders PR links', async () => {
    const { renderNotes } = await load();
    expect(renderNotes([{ title: 'KD-1: A', pr: 3, keys: ['KD-1'] }, { title: 'B', pr: null, keys: [] }], 'https://x/r'))
      .toBe('- KD-1: A ([#3](https://x/r/pull/3))\n- B');
    expect(renderNotes([])).toBe('- No changes.');
  });

  it('finds one version section in the changelog', async () => {
    const { section } = await load();
    const log = '# Changelog\n\nIntro\n\n## 0.2.0 (2026-12-01)\n\n- New\n\n## 0.1.0 (2026-11-11)\n\n- Old\n';
    expect(section(log, '0.2.0')).toBe('- New');
    expect(section(log, '0.1.0')).toBe('- Old');
    expect(section(log, '0.3.0')).toBe('');
  });
});

describe('version', () => {
  it('is the same in package.json, the plugin, /api/health and the MCP server', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const plugin = JSON.parse(readFileSync('plugins/claude-code/.claude-plugin/plugin.json', 'utf8'));
    expect(VERSION).toBe(pkg.version);
    expect(plugin.version).toBe(pkg.version);
    expect(SERVER_INFO.version).toBe(VERSION);
  });

  it('has a changelog entry for the current version', async () => {
    const { section } = await load();
    expect(section(readFileSync('CHANGELOG.md', 'utf8'), VERSION)).not.toBe('');
  });
});
