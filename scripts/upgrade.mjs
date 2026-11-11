#!/usr/bin/env node
// Helpers for the self-upgrade workflow (KD-67, .github/workflows/upgrade.yml).
//
//   node scripts/upgrade.mjs latest TAG...          print the newest stable vX.Y.Z among TAGs (empty if none)
//   node scripts/upgrade.mjs newer CURRENT CANDIDATE   exit 0 if CANDIDATE is a newer version than CURRENT
//   node scripts/upgrade.mjs carry OLD_TOML NEW_TOML   keep this copy's own settings (D1 id, domain, placement)
//                                                      from OLD_TOML in NEW_TOML (rewritten in place)
import { readFileSync, writeFileSync } from 'node:fs';

const STABLE = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function parse(v) {
  const m = String(v).trim().match(STABLE);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compare(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) throw new Error(`Not a version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** Newest stable release tag; pre-releases (v1.2.0-rc.1) are never picked up by self-upgrade. */
export function latest(tags) {
  return tags.filter((t) => STABLE.test(t) && t.startsWith('v')).sort(compare).pop() || '';
}

/**
 * The upgrade takes the release's files as they are, except for what belongs to this copy:
 * its D1 database id, a custom domain (routes) and a pinned placement region.
 */
export function carry(oldToml, newToml) {
  let out = newToml;
  const id = oldToml.match(/^database_id\s*=\s*"([^"]+)"/m)?.[1];
  if (id && id !== 'REPLACE_WITH_YOUR_D1_ID') out = out.replace(/^(database_id\s*=\s*")[^"]*(")/m, `$1${id}$2`);
  const routes = oldToml.match(/^routes\s*=.*$/m)?.[0];
  if (routes && !/^routes\s*=/m.test(out)) out = out.replace(/^(compatibility_date\s*=.*)$/m, `$1\n${routes}`);
  const region = oldToml.match(/^\[placement\][^\[]*?^region\s*=\s*"([^"]+)"/m)?.[1];
  if (region) out = out.replace(/^(\[placement\][^\[]*?)^mode\s*=\s*"smart"$/m, `$1region = "${region}"`);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'latest') console.log(latest(args));
  else if (cmd === 'newer') process.exit(compare(args[1], args[0]) > 0 ? 0 : 1);
  else if (cmd === 'carry') writeFileSync(args[1], carry(readFileSync(args[0], 'utf8'), readFileSync(args[1], 'utf8')));
  else { console.error('Usage: upgrade.mjs latest TAG... | newer CURRENT CANDIDATE | carry OLD_TOML NEW_TOML'); process.exit(1); }
}
