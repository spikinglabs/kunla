// Seeds a fresh LOCAL Kunla with a demo team and four days of history:
//   npm run dev   (in another terminal)
//   node scripts/demo-seed.mjs http://localhost:8787
// It drives the real API, then backdates the events in the local D1 so the work map has a week to show.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.argv[2] || 'http://localhost:8787';
const call = async (method, path, token, body) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(`${path}: ${d.error}`);
  return d;
};
const tool = (t, name, args) => call('POST', `/api/tools/${name}`, t, args).then((r) => r.result);

// Each step records [taskKey, eventType, hoursAgo]; occurrences of the same pair are matched in order.
const timeline = [];
const at = (key, type, hoursAgo) => timeline.push([key, type, hoursAgo]);
// "Today" is the current day after 2pm, otherwise yesterday, so the demo day has already happened.
const anchor = new Date(); if (anchor.getHours() < 14) anchor.setDate(anchor.getDate() - 1);
const D = (daysAgo, hour, min = 0) => { // hours before now for "N days ago at HH:MM"
  const n = new Date(); const t = new Date(anchor); t.setDate(anchor.getDate() - daysAgo); t.setHours(hour, min, 0, 0);
  return Math.max(0.05, (n - t) / 3600_000);
};

const { token: L } = await call('POST', '/api/setup', null, { name: 'L', project_key: 'MKT', project_name: 'Q1 campaign' });
await call('PATCH', '/api/projects/MKT', L, { playbook: '## Voice\n- Plain English, short sentences.\n- Prices in EUR.\n\n## Links\n- DACH landing page: https://example.com/dach' });
await call('POST', '/api/projects', L, { key: 'DATA', name: 'Sales data' });
const add = async (body) => (await call('POST', '/api/members', L, body)).token;
const maya = await add({ name: 'Maya', kind: 'human' });
const jon = await add({ name: 'Jon', kind: 'human' });
const cc = await add({ name: "L's Claude Code", kind: 'ai', platform: 'claude-code' });
const chat = await add({ name: "L's claude.ai", kind: 'ai', platform: 'claude-ai' });
const codex = (await call('POST', '/api/members', jon, { name: "Jon's Codex", kind: 'ai', platform: 'codex' })).token;
const gh = (n) => [{ url: `https://github.com/spikinglabs/site/pull/${n}`, title: `PR #${n}` }];

// Day -3
await call('POST', '/api/tasks', L, { project: 'MKT', title: 'Case study page for Brightline', brief: 'One page, the customer quote first, then three numbers from the pilot.', criteria: ['Quote above the fold', 'Three pilot numbers', 'Links the DACH page'] }); at('MKT-1', 'created', D(3, 8, 40));
await tool(cc, 'claim_task', { key: 'MKT-1' }); at('MKT-1', 'claimed', D(3, 9, 10));
await tool(cc, 'log_work', { task: 'MKT-1', summary: 'Drafted the page and pulled the pilot numbers from the deck.' }); at('MKT-1', 'work_logged', D(3, 10, 30));
await tool(cc, 'submit_for_review', { key: 'MKT-1', summary: 'Case study page with the quote first and three pilot numbers.', deliverables: gh(41) }); at('MKT-1', 'submitted', D(3, 11, 40));
await call('POST', '/api/tasks/MKT-1/review', maya, { verdict: 'approved' }); at('MKT-1', 'approved', D(3, 14, 0));
await call('POST', '/api/tasks', jon, { project: 'DATA', title: 'Clean the CRM export', brief: 'Dedupe companies and fill missing countries from the domain.', criteria: ['No duplicate companies', 'Country filled for 95% of rows'] }); at('DATA-1', 'created', D(3, 9, 0));
await tool(codex, 'claim_task', { key: 'DATA-1' }); at('DATA-1', 'claimed', D(3, 9, 50));
await tool(codex, 'submit_for_review', { key: 'DATA-1', summary: 'Removed 312 duplicates; country filled for 97% of rows.', deliverables: [{ url: 'https://github.com/spikinglabs/data/pull/7', title: 'PR #7' }] }); at('DATA-1', 'submitted', D(3, 12, 30));
await call('POST', '/api/tasks/DATA-1/review', jon, { verdict: 'approved' }); at('DATA-1', 'approved', D(3, 16, 10));

// Day -2
await call('POST', '/api/tasks', L, { project: 'MKT', title: 'Pricing table', brief: 'Free, Team and Enterprise side by side.', criteria: ['Mentions the free tier', 'Under 400 words'] }); at('MKT-2', 'created', D(2, 8, 50));
await tool(cc, 'claim_task', { key: 'MKT-2' }); at('MKT-2', 'claimed', D(2, 9, 30));
await tool(cc, 'submit_for_review', { key: 'MKT-2', summary: 'Pricing table with three tiers and a feature comparison.', deliverables: gh(44) }); at('MKT-2', 'submitted', D(2, 12, 0));
await call('POST', '/api/tasks/MKT-2/review', L, { verdict: 'changes_requested', what_was_wrong: 'The Team tier has no price.', rule: 'Every pricing tier shows a price, even if it is "Contact us".' });
at('MKT-2', 'rule_added', D(2, 15, 0)); at('MKT-2', 'changes_requested', D(2, 15, 0));
await tool(cc, 'submit_for_review', { key: 'MKT-2', summary: 'Added a price to every tier; Enterprise says Contact us.', deliverables: gh(44) }); at('MKT-2', 'submitted', D(2, 15, 40));
await call('POST', '/api/tasks/MKT-2/review', L, { verdict: 'approved' }); at('MKT-2', 'approved', D(2, 16, 30));
await tool(chat, 'log_work', { summary: 'Drafted a LinkedIn post about the launch', project: 'MKT', deliverables: [{ url: 'https://docs.google.com/document/d/linkedin-launch', title: 'LinkedIn draft' }] }); at('MKT-3', 'work_logged', D(2, 11, 0));

// Day -1
await call('POST', '/api/tasks', L, { project: 'MKT', title: 'Q1 newsletter draft', brief: 'Draft the Q1 newsletter for DACH prospects. Announce the scheduling assistant and the March webinar.', criteria: ['Under 400 words', 'Links the DACH landing page', 'Mentions the March webinar'] }); at('MKT-4', 'created', D(1, 9, 30));
await tool(chat, 'claim_task', { key: 'MKT-4' }); at('MKT-4', 'claimed', D(1, 10, 0));
await tool(chat, 'submit_for_review', { key: 'MKT-4', summary: '312 words. Opens with the scheduling assistant, closes with the webinar on 19 March and the DACH page.', deliverables: [{ url: 'https://docs.google.com/document/d/q1-newsletter', title: 'Q1 newsletter v2' }] }); at('MKT-4', 'submitted', D(1, 11, 20));
await call('POST', '/api/tasks', jon, { project: 'DATA', title: 'Lead scoring for DACH', brief: 'Score inbound DACH leads by fit and intent; flag the top 20 for Jon.', criteria: ['Score between 0 and 100', 'Top 20 list in the sheet'] }); at('DATA-2', 'created', D(1, 13, 0));
await tool(codex, 'claim_task', { key: 'DATA-2' }); at('DATA-2', 'claimed', D(1, 14, 0));
await tool(codex, 'log_work', { task: 'DATA-2', summary: 'Built fit scores from company size and industry.' }); at('DATA-2', 'work_logged', D(1, 16, 30));

// Today
await tool(codex, 'update_task', { key: 'DATA-2', blocked_question: 'What is the maximum discount I can assume for DACH leads? The pricing page says 10% for annual plans, but Jon offered 20% to one pilot.', blocked_on: 'L' }); at('DATA-2', 'blocked', D(0, 9, 10));
await call('POST', '/api/tasks', L, { project: 'MKT', title: 'Webinar invite email', brief: 'Invite DACH prospects to the 19 March webinar. Two subject lines to test.', criteria: ['Two subject lines', 'Under 150 words'] }); at('MKT-5', 'created', D(0, 9, 30));
await tool(cc, 'claim_task', { key: 'MKT-5' }); at('MKT-5', 'claimed', D(0, 10, 30));
await tool(cc, 'log_work', { task: 'MKT-5', summary: 'Wrote two subject lines and the first draft.' }); at('MKT-5', 'work_logged', D(0, 11, 0));
await tool(cc, 'create_task', { project: 'MKT', title: 'Add EUR prices to the FAQ', brief: 'Found while writing MKT-2: the FAQ still lists prices in USD only.' }); at('MKT-6', 'created', D(0, 10, 50));
await call('POST', '/api/tasks', L, { project: 'DATA', title: 'Week 45 pipeline summary', brief: 'From the CRM export. Top five deals and the risks.', criteria: ['Top 5 deals', 'Risks'] }); at('DATA-3', 'created', D(0, 8, 0));

// Backdate in the local D1.
const iso = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const seen = new Map();
const sql = [];
for (const [key, type, h] of timeline) {
  const k = key + type; const n = seen.get(k) ?? 0; seen.set(k, n + 1);
  sql.push(`UPDATE events SET created_at = '${iso(h)}' WHERE id = (SELECT e.id FROM events e JOIN tasks t ON t.id = e.task_id WHERE t.key = '${key}' AND e.type = '${type}' ORDER BY e.id LIMIT 1 OFFSET ${n});`);
}
sql.push(`UPDATE tasks SET created_at = (SELECT MIN(created_at) FROM events WHERE task_id = tasks.id), updated_at = (SELECT MAX(created_at) FROM events WHERE task_id = tasks.id);`);
sql.push(`UPDATE rules SET created_at = (SELECT MIN(e.created_at) FROM events e WHERE e.type = 'rule_added');`);
sql.push(`UPDATE reviews SET created_at = (SELECT MAX(e.created_at) FROM events e WHERE e.task_id = reviews.task_id AND e.type IN ('approved','changes_requested') AND e.created_at <= (SELECT MAX(created_at) FROM events));`);
sql.push(`UPDATE tasks SET lease_expires_at = '${new Date(Date.now() + 30 * 60_000).toISOString()}' WHERE status = 'in_progress';`);
const dir = mkdtempSync(join(tmpdir(), 'kunla-seed-'));
writeFileSync(join(dir, 'backdate.sql'), sql.join('\n'));
execFileSync('npx', ['wrangler', 'd1', 'execute', 'kunla', '--local', '--file', join(dir, 'backdate.sql')], { stdio: 'ignore' });
// One fresh update so the agent on MKT-5 shows as live.
await tool(cc, 'log_work', { task: 'MKT-5', summary: 'Checked both subject lines against the playbook voice.' });
console.log(JSON.stringify({ L, maya, jon, cc, chat, codex }));
