// Seeds a fresh local Kunla with a small demo team: node scripts/demo-seed.mjs http://localhost:8787
const base = process.argv[2] || 'http://localhost:8787';
const call = async (method, path, token, body) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(`${path}: ${d.error}`);
  return d;
};
const tool = (t, name, args) => call('POST', `/api/tools/${name}`, t, args).then((r) => r.result);

const { token: L } = await call('POST', '/api/setup', null, { name: 'L', project_key: 'MKT', project_name: 'Q1 campaign' });
await call('PATCH', '/api/projects/MKT', L, { playbook: '# Style\n- Plain English, short sentences.\n- Prices in EUR.' });
await call('POST', '/api/projects', L, { key: 'SALES', name: 'Weekly sales report' });
const cc = (await call('POST', '/api/members', L, { name: "L's Claude Code", kind: 'ai', platform: 'claude-code' })).token;
const chat = (await call('POST', '/api/members', L, { name: "L's claude.ai", kind: 'ai', platform: 'claude-ai' })).token;
const maya = (await call('POST', '/api/members', L, { name: 'Maya', kind: 'human' })).token;

await call('POST', '/api/tasks', L, { project: 'MKT', title: 'Draft the pricing page', brief: 'Three tiers: Free, Team, Enterprise. Link to the signup.', criteria: ['Mentions the free tier', 'Under 400 words'] });
await call('POST', '/api/tasks', L, { project: 'MKT', title: 'October newsletter', brief: 'Highlights from the launch.' });
await call('POST', '/api/tasks', maya, { project: 'SALES', title: 'Week 44 pipeline summary', brief: 'From the CRM export in Drive.', criteria: ['Top 5 deals', 'Risks'] });
await call('POST', '/api/tasks', L, { project: 'MKT', title: 'Competitor teardown: Linear' });

await tool(cc, 'claim_task', { key: 'MKT-1' });
await tool(cc, 'log_work', { task: 'MKT-1', summary: 'Wrote the three tiers and the comparison table.' });
await tool(cc, 'submit_for_review', { key: 'MKT-1', summary: 'Pricing page drafted with three tiers and a comparison table.', deliverables: [{ url: 'https://github.com/spikinglabs/site/pull/12', title: 'PR #12' }] });
await tool(chat, 'claim_task', { key: 'SALES-1' });
await tool(chat, 'update_task', { key: 'SALES-1', blocked_question: 'Should the summary include deals under 10k EUR?' });
await tool(chat, 'log_work', { summary: 'Drafted a LinkedIn post about the launch from our chat', project: 'MKT', deliverables: [{ url: 'https://docs.google.com/document/d/abc', title: 'LinkedIn draft' }] });
await tool(cc, 'create_task', { project: 'MKT', title: 'Add EUR prices to the FAQ', brief: 'Found while drafting MKT-1: the FAQ still lists USD.' });
await tool(cc, 'claim_task', { key: 'MKT-2' });
console.log(JSON.stringify({ L, cc, chat, maya }));
