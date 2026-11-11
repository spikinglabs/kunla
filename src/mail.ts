// Sending email (KD-70): only sign-in links for now. Three ways, the first one set up wins:
// - Kunla Cloud (KUNLA_CLOUD_MAIL=true): a signed call to the control plane, which sends with Cloudflare Email Service.
// - A Cloudflare Email Service binding named EMAIL (Workers Paid; the domain must use Cloudflare DNS) + MAIL_FROM.
// - Resend: RESEND_API_KEY + MAIL_FROM (works on any plan).
// With none of them, Kunla sends nothing and offers no email sign-in.
import * as plan from './plan';

export interface MailEnv {
  EMAIL?: { send(message: { from: string; to: string; subject: string; text: string }): Promise<unknown> };
  RESEND_API_KEY?: string; MAIL_FROM?: string;
  KUNLA_CLOUD_MAIL?: string; KUNLA_CLOUD_HOOK?: string; KUNLA_TENANT?: string;
}
export interface Mail { to: string; subject: string; text: string }

const viaCloud = (env: MailEnv) => env.KUNLA_CLOUD_MAIL === 'true' && !!env.KUNLA_CLOUD_HOOK && !!env.KUNLA_TENANT && plan.hosted();

export const mailOn = (env: MailEnv) => viaCloud(env) || (!!env.MAIL_FROM && (!!env.EMAIL || !!env.RESEND_API_KEY));

export async function send(env: MailEnv, m: Mail, fetcher: typeof fetch = fetch): Promise<void> {
  if (viaCloud(env)) {
    const body = JSON.stringify(m);
    const res = await fetcher(`${new URL(env.KUNLA_CLOUD_HOOK!).origin}/api/teams/${encodeURIComponent(env.KUNLA_TENANT!)}/mail`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(await plan.signedHeaders(body)) }, body });
    if (!res.ok) throw new Error(`Kunla Cloud could not send the email (${res.status}).`);
    return;
  }
  if (!env.MAIL_FROM) throw new Error('Email is not set up on this Kunla.');
  if (env.EMAIL) { await env.EMAIL.send({ from: env.MAIL_FROM, to: m.to, subject: m.subject, text: m.text }); return; }
  if (env.RESEND_API_KEY) {
    const res = await fetcher('https://api.resend.com/emails', { method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [m.to], subject: m.subject, text: m.text }) });
    if (!res.ok) throw new Error(`Resend refused the email (${res.status}).`);
    return;
  }
  throw new Error('Email is not set up on this Kunla.');
}
