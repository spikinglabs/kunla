// KD-67: the self-upgrade workflow's helpers.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const script = '../scripts/upgrade.mjs';
const load = () => import(/* @vite-ignore */ script as string) as Promise<any>;

describe('self-upgrade', () => {
  it('picks the newest stable release tag', async () => {
    const { latest } = await load();
    expect(latest(['v0.1.0', 'v0.10.0', 'v0.9.3', 'v1.0.0-rc.1', 'cli-v2.0.0', 'junk'])).toBe('v0.10.0');
    expect(latest(['cli-v0.1.0'])).toBe('');
  });

  it('upgrades only to newer versions', async () => {
    const { compare } = await load();
    expect(compare('v0.2.0', '0.1.9')).toBeGreaterThan(0);
    expect(compare('0.1.0', 'v0.1.0')).toBe(0);
    expect(compare('1.0.0', '1.0.1')).toBeLessThan(0);
  });

  it("keeps the copy's database, domain and placement in the new wrangler.toml", async () => {
    const { carry } = await load();
    const release = readFileSync('wrangler.toml', 'utf8');
    const mine = release
      .replace('REPLACE_WITH_YOUR_D1_ID', '5bfa1076-aaaa')
      .replace(/^(compatibility_date.*)$/m, '$1\nroutes = [{ pattern = "kunla.example.com", custom_domain = true }]')
      .replace(/^mode = "smart"$/m, 'region = "aws:eu-central-1"');
    const out = carry(mine, release);
    expect(out).toContain('database_id = "5bfa1076-aaaa"');
    expect(out).toContain('routes = [{ pattern = "kunla.example.com", custom_domain = true }]');
    expect(out).toContain('region = "aws:eu-central-1"');
    expect(out).not.toMatch(/^mode = "smart"$/m);
    // A copy that never changed anything gets the release file unchanged.
    expect(carry(release, release)).toBe(release);
  });
});
