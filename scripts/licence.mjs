#!/usr/bin/env node
// Makes Kunla Enterprise licence keys (KD-75). Run by Spiking Labs only; the private key never goes in the repo.
//
//   node scripts/licence.mjs keygen PRIVATE_KEY_FILE
//       makes an Ed25519 key pair, writes the private key (PKCS#8, base64url) to PRIVATE_KEY_FILE and prints the
//       public key to paste into LICENCE_PUBLIC_KEY in src/licence.ts
//   node scripts/licence.mjs sign PRIVATE_KEY_FILE '{"licensee":"Acme","features":["sso","audit"],"seats":50,"expires_at":"2027-12-31"}'
//       prints a licence key; the customer sets it as the KUNLA_LICENSE secret (wrangler secret put KUNLA_LICENSE)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export async function keygen() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return {
    privateKey: b64u(await crypto.subtle.exportKey('pkcs8', kp.privateKey)),
    publicKey: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)),
  };
}

export async function sign(privateKey, payload) {
  const key = await crypto.subtle.importKey('pkcs8', Buffer.from(privateKey, 'base64url'), { name: 'Ed25519' }, false, ['sign']);
  const body = b64u(JSON.stringify(payload));
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(body));
  return `${body}.${b64u(sig)}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, file, json] = process.argv.slice(2);
  if (cmd === 'keygen' && file) {
    if (existsSync(file)) { console.error(`${file} exists; not overwriting a private key.`); process.exit(1); }
    const { privateKey, publicKey } = await keygen();
    writeFileSync(file, privateKey + '\n', { mode: 0o600 });
    console.log(`Private key written to ${file}. Keep it in a password manager, never in the repo.\nPublic key (paste into LICENCE_PUBLIC_KEY in src/licence.ts):\n${publicKey}`);
  } else if (cmd === 'sign' && file && json) {
    console.log(await sign(readFileSync(file, 'utf8').trim(), JSON.parse(json)));
  } else {
    console.error('Usage: licence.mjs keygen PRIVATE_KEY_FILE | sign PRIVATE_KEY_FILE PAYLOAD_JSON');
    process.exit(1);
  }
}
