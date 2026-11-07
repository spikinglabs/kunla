// Kinds of work. Kunla is a record of all the team's work, not only code: a discussion, a paper
// someone read, an article, market research or a campaign are tasks too. The kind says what the
// outcome looks like, what to hand in, and how to cite the task. Plain functions, no storage.

export const KINDS = ['code', 'writing', 'research', 'reading', 'learning', 'discussion', 'marketing', 'sales', 'data', 'design', 'other'] as const;
export type WorkKind = typeof KINDS[number];

export function isKind(k: unknown): k is WorkKind {
  return typeof k === 'string' && (KINDS as readonly string[]).includes(k);
}

/** Accepts a kind or a common synonym ("article" → writing, "paper" → reading); throws nothing, returns null if unknown. */
export function normalizeKind(k: unknown): WorkKind | null {
  if (typeof k !== 'string' || !k.trim()) return null;
  const s = k.trim().toLowerCase();
  if (isKind(s)) return s;
  const alias: Record<string, WorkKind> = {
    coding: 'code', engineering: 'code', dev: 'code', development: 'code', bug: 'code', pr: 'code',
    article: 'writing', blog: 'writing', post: 'writing', docs: 'writing', doc: 'writing', draft: 'writing', copy: 'writing',
    'market research': 'research', 'market-research': 'research', analysis: 'research', investigation: 'research',
    paper: 'reading', papers: 'reading', 'paper reading': 'reading', book: 'reading', literature: 'reading',
    study: 'learning', course: 'learning', tutorial: 'learning',
    meeting: 'discussion', brainstorm: 'discussion', call: 'discussion', chat: 'discussion', decision: 'discussion',
    campaign: 'marketing', social: 'marketing', seo: 'marketing', launch: 'marketing',
    outreach: 'sales', lead: 'sales', deal: 'sales', customer: 'sales',
    analytics: 'data', dashboard: 'data', query: 'data', metrics: 'data',
    ux: 'design', ui: 'design', mockup: 'design', 'mock-up': 'design',
  };
  return alias[s] ?? null;
}

const PAPER_HOSTS = /(^|\.)(arxiv\.org|doi\.org|openreview\.net|semanticscholar\.org|pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov|biorxiv\.org|medrxiv\.org|scispace\.com|consensus\.app|ssrn\.com|aclanthology\.org|proceedings\.neurips\.cc|dl\.acm\.org|ieeexplore\.ieee\.org|nature\.com|sciencedirect\.com|springer\.com|researchgate\.net|scholar\.google\.com|paperswithcode\.com)$/;

/** What a deliverable link is, from its URL, so a reviewer knows what they're opening. */
export function linkType(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return 'link'; }
  const h = u.hostname.replace(/^www\./, '').toLowerCase();
  const p = u.pathname;
  if (h === 'github.com' || h.endsWith('.github.com')) {
    if (/\/pull\/\d+/.test(p)) return 'pr';
    if (/\/issues\/\d+/.test(p)) return 'issue';
    if (/\/commit\//.test(p)) return 'commit';
    if (/\/discussions\/\d+/.test(p)) return 'chat';
    return 'repo';
  }
  if (h === 'gitlab.com' && /\/merge_requests\/\d+/.test(p)) return 'pr';
  if (h === 'huggingface.co' && p.startsWith('/papers')) return 'paper';
  if (PAPER_HOSTS.test(h)) return 'paper';
  if (h === 'docs.google.com') {
    if (p.startsWith('/spreadsheets')) return 'sheet';
    if (p.startsWith('/presentation')) return 'slides';
    if (p.startsWith('/forms')) return 'form';
    return 'doc';
  }
  if (h === 'claude.ai' || h.endsWith('.claude.ai')) {
    if (p.includes('/artifact')) return 'doc';
    return 'chat';
  }
  if (/(^|\.)(chatgpt\.com|chat\.openai\.com|gemini\.google\.com|slack\.com|teams\.microsoft\.com|discord\.com)$/.test(h)) return 'chat';
  if (/(^|\.)(notion\.so|notion\.site|atlassian\.net|confluence\.|quip\.com|coda\.io|dropbox\.com|paper\.dropbox\.com|hackmd\.io|onedrive\.live\.com|sharepoint\.com)/.test(h)) return 'doc';
  if (/(^|\.)(airtable\.com|smartsheet\.com)$/.test(h)) return 'sheet';
  if (/(^|\.)(pitch\.com|slides\.com|canva\.com)$/.test(h)) return 'slides';
  if (/(^|\.)(figma\.com|miro\.com|excalidraw\.com)$/.test(h)) return 'design';
  if (/(^|\.)(linkedin\.com|x\.com|twitter\.com|medium\.com|substack\.com|bsky\.app|threads\.net|mastodon\.social|reddit\.com|news\.ycombinator\.com|dev\.to|hashnode\.com)$/.test(h)) return 'post';
  if (/(^|\.)(youtube\.com|youtu\.be|vimeo\.com|loom\.com)$/.test(h)) return 'video';
  if (/\.(pdf|docx?|xlsx?|pptx?|csv|md)$/i.test(p)) return 'file';
  return 'link';
}

// Word cues per kind, most specific first. Only a guess for tasks created without a kind.
const CUES: [WorkKind, RegExp][] = [
  ['reading', /\b(read(ing)?|papers?|preprint|literature|book|chapter|arxiv)\b/i],
  ['discussion', /\b(discuss(ion|ing)?|meeting|brainstorm(ing)?|debate|sync|1:1|one-on-one|talk (about|through)|call with|retro(spective)?|workshop)\b/i],
  ['learning', /\b(learn(ing)?|study(ing)?|course|tutorial|understand|get up to speed|explore how|how does)\b/i],
  ['research', /\b(market (research|scan|sizing|size)|size (the|a|our) market|tam|competitor|competitive|landscape|research|survey|benchmark|investigate|scan of|compare)\b/i],
  ['marketing', /\b(marketing|campaign|launch|seo|ads?|social media|newsletter|linkedin|tweet|landing page|brand(ing)?|press release|announcement|go-to-market|gtm|webinar)\b/i],
  ['sales', /\b(sales|lead|leads|prospect(ing)?|deal|pipeline|outreach|pitch|demo for|customer call|renewal|quote|rfp)\b/i],
  ['writing', /\b(write|writing|draft|article|blog|post|essay|copy(writing)?|op-ed|whitepaper|white paper|documentation|docs|memo|readme)\b/i],
  ['data', /\b(dashboard|sql|query|metrics?|kpis?|dataset|data (analysis|pipeline)|cohort|funnel|a\/b test|forecast)\b/i],
  ['design', /\b(design|mock-?ups?|wireframes?|figma|logo|prototype|ux|ui)\b/i],
  ['code', /\b(fix|bug|implement|refactor|api|endpoint|deploy|migration|tests?|build|ci|merge|pr|feature|webhook|worker|typescript|python|cli|sdk)\b/i],
];

/** Best guess at the kind of work from its title, brief and links. 'other' when nothing fits. */
export function inferKind(title: string, brief = '', urls: string[] = []): WorkKind {
  const types = urls.map(linkType);
  if (types.some((t) => t === 'pr' || t === 'commit')) return 'code';
  if (types.includes('paper')) return 'reading';
  for (const [k, re] of CUES) if (re.test(title)) return k;
  for (const [k, re] of CUES) if (re.test(brief.slice(0, 400))) return k;
  return 'other';
}

export const KIND_LABEL: Record<WorkKind, string> = {
  code: 'Code', writing: 'Writing', research: 'Research', reading: 'Reading', learning: 'Learning',
  discussion: 'Discussion', marketing: 'Marketing', sales: 'Sales', data: 'Data', design: 'Design', other: 'Other',
};

/**
 * What finished looks like for each kind: what to hand in, how to cite the task, and what a
 * person's approval means. Sent with every task so any agent knows how to finish non-code work.
 */
export const GUIDE: Record<WorkKind, { outcome: string; hand_in: string; cite: string; approval: string }> = {
  code: {
    outcome: 'A change in the code base.',
    hand_in: 'A pull request link.',
    cite: 'commit_trailer in every commit, pr_title for the PR.',
    approval: 'Approving merges the PR.',
  },
  writing: {
    outcome: 'A draft or a published piece (article, post, doc, memo).',
    hand_in: 'A link to the draft (doc, artifact, page). Add notes on who it is for and what feedback you want.',
    cite: 'doc_source_line under the title of the draft.',
    approval: 'Approving means it is ready to publish. Publish only if the brief says so; then log_work the published link.',
  },
  research: {
    outcome: 'An answer to a question, with sources (market research, competitor scan, investigation).',
    hand_in: 'notes that lead with the answer, then the findings and the sources. Link a doc or sheet if it is long.',
    cite: 'doc_source_line at the top of the doc or notes.',
    approval: 'Approving accepts the findings as the team’s current view.',
  },
  reading: {
    outcome: 'Notes on a paper, article or book.',
    hand_in: 'A link to what you read, plus notes: what it claims, how solid it is, and what it means for us.',
    cite: 'doc_source_line at the top of the notes.',
    approval: 'Approving accepts the notes; reading tasks can also be logged straight to done with log_work.',
  },
  learning: {
    outcome: 'Something learned: a skill, a tool, a topic.',
    hand_in: 'notes on what you learned, what is still unclear, and links to the best sources.',
    cite: 'message_line when you share it.',
    approval: 'Usually none needed: log_work with status done.',
  },
  discussion: {
    outcome: 'A conversation that reached decisions or next steps (meeting, brainstorm, chat).',
    hand_in: 'notes with the decisions, open questions and next steps, and a link to the chat or recording if there is one. Next steps that are real work become their own tasks.',
    cite: 'message_line in follow-up messages.',
    approval: 'Usually none needed: log_work with status done. Send it for review only when the decision needs a person’s sign-off.',
  },
  marketing: {
    outcome: 'A marketing asset or action (campaign, post, landing page, email) and its results.',
    hand_in: 'A link to the asset, and notes on audience, channel and when it goes out. Log results later with log_work.',
    cite: 'doc_source_line in the brief or asset doc; message_line in announcements.',
    approval: 'Approving means it can go out. Send or post it only if the brief says so.',
  },
  sales: {
    outcome: 'Progress with a customer or prospect.',
    hand_in: 'notes with where things stand, the next step and its date; link the CRM record or email thread.',
    cite: 'message_line in internal threads.',
    approval: 'Approving accepts the next step. Never contact a customer unless the brief says so.',
  },
  data: {
    outcome: 'An answer from data (analysis, dashboard, metric).',
    hand_in: 'notes that lead with the answer and its caveats; link the query, notebook, sheet or dashboard.',
    cite: 'doc_source_line in the notebook or dashboard description.',
    approval: 'Approving accepts the numbers.',
  },
  design: {
    outcome: 'A design (screen, flow, visual).',
    hand_in: 'A link to the design and notes on what feedback you want.',
    cite: 'doc_source_line in the design file description.',
    approval: 'Approving accepts the design for the next step.',
  },
  other: {
    outcome: 'Whatever the brief asks for.',
    hand_in: 'A link to the work, or notes that show the outcome.',
    cite: 'doc_source_line in documents, message_line in messages.',
    approval: 'Approving marks it done.',
  },
};
