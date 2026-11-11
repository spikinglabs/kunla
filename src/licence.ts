// Which edition this Kunla runs (KD-75). Without a licence it is the free, complete Community edition. A licence
// key (self-hosted) or the plan Kunla Cloud sets (the same key, issued per team) turns on company-wide ee/
// features. The key is a signed statement: base64url(JSON payload) + "." + base64url(Ed25519 signature), checked
// offline against Spiking Labs' public key, so no Kunla ever phones home to check it.
export interface Licence {
  edition: 'community' | 'enterprise';
  licensee: string | null;
  features: string[];      // e.g. ["sso", "scim", "audit", "policies"]
  seats: number | null;    // people (AI members are free); null = unlimited
  expires_at: string | null;
  problem?: string;        // why a key that was set doesn't count (shown to admins)
}

export const COMMUNITY: Licence = { edition: 'community', licensee: null, features: [], seats: null, expires_at: null };

// Spiking Labs' licence-signing public key (raw Ed25519, base64url). Empty until the key pair is made with
// `node scripts/licence.mjs keygen`; until then no key is accepted and every Kunla is Community.
export const LICENCE_PUBLIC_KEY = '';

const b64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (ch) => ch.charCodeAt(0));

let cached: { key: string; at: number; value: Licence } | null = null;

/** Reads and checks a licence key. Never throws: a bad key means Community, with the reason in `problem`. */
export async function readLicence(key: string | undefined, now = new Date(), publicKey = LICENCE_PUBLIC_KEY): Promise<Licence> {
  const k = (key ?? '').trim();
  if (!k) return COMMUNITY;
  if (cached && cached.key === k + publicKey && now.getTime() - cached.at < 3_600_000) return cached.value;
  const value = await check(k, now, publicKey);
  cached = { key: k + publicKey, at: now.getTime(), value };
  return value;
}

async function check(k: string, now: Date, publicKey: string): Promise<Licence> {
  const bad = (problem: string): Licence => ({ ...COMMUNITY, problem });
  if (!publicKey) return bad('This Kunla has no licence public key, so licence keys are not checked.');
  const [body, sig] = k.split('.');
  if (!body || !sig) return bad('The licence key is not in the right format.');
  try {
    const pub = await crypto.subtle.importKey('raw', b64u(publicKey), { name: 'Ed25519' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, pub, b64u(sig), new TextEncoder().encode(body));
    if (!ok) return bad('The licence key signature does not match.');
    const p = JSON.parse(new TextDecoder().decode(b64u(body)));
    if (p.expires_at && new Date(p.expires_at) < now) return bad(`The licence expired on ${String(p.expires_at).slice(0, 10)}.`);
    return {
      edition: 'enterprise',
      licensee: typeof p.licensee === 'string' ? p.licensee : null,
      features: Array.isArray(p.features) ? p.features.filter((f: unknown) => typeof f === 'string') : [],
      seats: typeof p.seats === 'number' ? p.seats : null,
      expires_at: typeof p.expires_at === 'string' ? p.expires_at : null,
    };
  } catch {
    return bad('The licence key could not be read.');
  }
}

export const hasFeature = (l: Licence, feature: string) => l.edition === 'enterprise' && l.features.includes(feature);
