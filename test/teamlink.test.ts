// KD-85: a team's own link, /w/ACME, opens the app on that workspace.
import { describe, it, expect } from 'vitest';
import app from '../src/index';
import { makeD1 } from './d1-shim';

describe('/w/:key', () => {
  it('sends a team link to the app with the workspace key in the fragment', async () => {
    const env = { DB: makeD1() } as any;
    const r = await app.fetch(new Request('https://kunla.test/w/acme-co'), env, { waitUntil() {}, passThroughOnException() {} } as any);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/app/#/w/ACMECO');
  });
});
