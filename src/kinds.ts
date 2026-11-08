// Kinds of work. Kunla is a record of all the team's work, not only code: a discussion, a paper
// someone read, an article, market research or a campaign are tasks too. A kind says what the
// outcome looks like, what to hand in, and what a person's approval means.
//
// Kunla ships a short default list, grouped by what the work produces rather than by department.
// Each workspace can replace it, and each project can replace the workspace's list (project wins,
// then workspace, then these defaults). Plain functions, no storage.

export const DEFAULT_KINDS = ['code', 'writing', 'research', 'learning', 'discussion', 'outreach', 'design', 'operations', 'other'] as const;
/** @deprecated name kept for imports; the default list. */
export const KINDS = DEFAULT_KINDS;
export type BuiltinKind = typeof DEFAULT_KINDS[number];

export interface KindDef {
  key: string;           // stored on the task, e.g. "research" or "customer-calls"
  label: string;         // shown to people, e.g. "Research"
  about: string;         // what falls under it, one line
  hand_in: string;       // what to hand in when it is finished
  approval: string;      // what a person's approval means
  words: string[];       // extra words that suggest this kind when guessing
  builtin: boolean;      // one of Kunla's own kinds (has its own guessing cues)
}

const B = (key: BuiltinKind, label: string, about: string, hand_in: string, approval: string): KindDef =>
  ({ key, label, about, hand_in, approval, words: [], builtin: true });

/** Kunla's own kinds. Seven cover what work produces; Other catches the rest. */
export const BUILTIN: Record<BuiltinKind, KindDef> = {
  code: B('code', 'Code', 'Changes to software: features, fixes, scripts.',
    'A pull request link. Cite the key in the commit trailer and PR title.', 'Approving merges the PR.'),
  writing: B('writing', 'Writing', 'Anything written for others: articles, posts, docs, emails, slides.',
    'A link to the draft (doc, artifact, page), with notes on who it is for and what feedback you want. Put the doc source line under the title.',
    'Approving means it is ready to publish. Publish only if the brief says so, then log the published link.'),
  research: B('research', 'Research', 'Finding an answer: market research, competitors, data analysis, investigations.',
    'Notes that lead with the answer, then the findings and their sources. Link a doc, sheet or notebook if it is long.',
    'Approving accepts the findings as the team’s current view.'),
  learning: B('learning', 'Learning', 'Getting smarter: reading papers and books, courses, trying a tool.',
    'Notes: what it says or what you learned, how solid it is, what it means for us, and what is still unclear. Link what you read.',
    'Usually no approval needed: log it as done.'),
  discussion: B('discussion', 'Discussion', 'Talking it through: meetings, brainstorms, chats that reach a decision.',
    'Notes with the decisions, open questions and next steps; link the chat or recording if there is one. Real next steps become their own tasks.',
    'Usually no approval needed: log it as done. Send it for review when a decision needs a person’s sign-off.'),
  outreach: B('outreach', 'Outreach', 'Work that goes out to people outside the team: marketing, sales, publishing, events, partners.',
    'A link to the asset or thread, with notes on audience, channel and timing. Log results later.',
    'Approving means it can go out. Send, post or contact anyone only if the brief says so.'),
  design: B('design', 'Design', 'Making it look and work right: screens, flows, visuals, brand.',
    'A link to the design, with notes on what feedback you want.', 'Approving accepts the design for the next step.'),
  operations: B('operations', 'Operations', 'Keeping things running: planning, admin, hiring, finance, process.',
    'A short note on what was done or decided, with links to any records.', 'Approving marks it done.'),
  other: B('other', 'Other', 'Anything else.', 'A link to the work, or notes that show the outcome.', 'Approving marks it done.'),
};

export const KIND_LABEL: Record<string, string> = Object.fromEntries(Object.values(BUILTIN).map((k) => [k.key, k.label]));
export const GUIDE: Record<string, { about: string; hand_in: string; approval: string }> =
  Object.fromEntries(Object.values(BUILTIN).map((k) => [k.key, { about: k.about, hand_in: k.hand_in, approval: k.approval }]));

/** Words people (and agents) use for a built-in kind. Also maps the earlier, longer list onto this one. */
const ALIAS: Record<string, BuiltinKind> = {
  coding: 'code', engineering: 'code', dev: 'code', development: 'code', bug: 'code', pr: 'code', software: 'code',
  write: 'writing', article: 'writing', blog: 'writing', post: 'writing', docs: 'writing', doc: 'writing', draft: 'writing', copy: 'writing', content: 'writing',
  analysis: 'research', investigation: 'research', data: 'research', analytics: 'research', 'market research': 'research', 'market-research': 'research',
  reading: 'learning', read: 'learning', paper: 'learning', papers: 'learning', book: 'learning', literature: 'learning', study: 'learning', course: 'learning', learn: 'learning',
  meeting: 'discussion', brainstorm: 'discussion', call: 'discussion', chat: 'discussion', decision: 'discussion', discuss: 'discussion',
  marketing: 'outreach', sales: 'outreach', campaign: 'outreach', social: 'outreach', seo: 'outreach', launch: 'outreach', pr_outreach: 'outreach', events: 'outreach', partnerships: 'outreach', community: 'outreach',
  ux: 'design', ui: 'design', mockup: 'design', 'mock-up': 'design', brand: 'design',
  ops: 'operations', admin: 'operations', planning: 'operations', hiring: 'operations', finance: 'operations', process: 'operations', legal: 'operations', hr: 'operations',
};

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
const isBuiltin = (k: string): k is BuiltinKind => (DEFAULT_KINDS as readonly string[]).includes(k);

/** A built-in kind from a key, label or common word ("Article" → writing, "paper" → learning); null if none. */
export function normalizeKind(k: unknown): BuiltinKind | null {
  if (typeof k !== 'string' || !k.trim()) return null;
  const s = k.trim().toLowerCase();
  if (isBuiltin(s)) return s;
  return ALIAS[s] ?? null;
}

export class KindsError extends Error {}

/**
 * Read a kinds setting: an array whose entries are a built-in key ("research"), a line
 * ("Customer calls: notes with the next step"), or an object { label, hand_in?, approval?, about?, words? }.
 * Returns null for "inherit" (null or undefined). Throws KindsError on bad input.
 */
export function parseKinds(input: unknown): KindDef[] | null {
  if (input === null || input === undefined) return null;
  let list = input;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = (list as string).split('\n'); } }
  if (!Array.isArray(list)) throw new KindsError('kinds must be a list, or null to use the defaults.');
  const out: KindDef[] = [];
  for (const raw of list) {
    let label = '', hand_in = '', approval = '', about = '', words: string[] = [], key = '';
    if (typeof raw === 'string') {
      const line = raw.replace(/^\s*[-*•]\s*/, '').trim();
      if (!line) continue;
      const m = line.match(/^(.+?)\s*(?::|\s[—–-]\s)\s*(.+)$/);
      label = (m ? m[1] : line).trim(); hand_in = m ? m[2].trim() : '';
    } else if (raw && typeof raw === 'object') {
      const o = raw as Record<string, unknown>;
      label = String(o.label ?? o.key ?? '').trim(); key = String(o.key ?? '').trim().toLowerCase();
      hand_in = String(o.hand_in ?? '').trim(); approval = String(o.approval ?? '').trim(); about = String(o.about ?? '').trim();
      words = Array.isArray(o.words) ? o.words.map((w) => String(w).trim().toLowerCase()).filter(Boolean).slice(0, 20) : [];
    } else continue;
    if (!label) continue;
    if (label.length > 30) throw new KindsError(`Kind names are at most 30 characters (${label.slice(0, 40)}).`);
    if (hand_in.length > 300 || approval.length > 300 || about.length > 300) throw new KindsError(`Keep the description of ${label} under 300 characters.`);
    // An exact built-in key or name keeps Kunla's own kind (and its guessing); anything else is the team's own.
    const lower = label.toLowerCase();
    const builtinKey = isBuiltin(key) ? key : isBuiltin(lower) ? lower : (Object.values(BUILTIN).find((b) => b.label.toLowerCase() === lower)?.key ?? null);
    const base = builtinKey ? BUILTIN[builtinKey as BuiltinKind] : null;
    const like = base ?? (ALIAS[lower] ? BUILTIN[ALIAS[lower]] : BUILTIN.other);
    const k = base ? base.key : (key && /^[a-z][a-z0-9-]{0,23}$/.test(key) ? key : slug(label));
    if (!k) throw new KindsError(`Can't make a key from ${label}.`);
    if (out.some((d) => d.key === k)) continue;
    out.push({
      key: k, label: base && label.toLowerCase() === base.key ? base.label : label,
      about: about || (base ? base.about : ''), hand_in: hand_in || like.hand_in, approval: approval || like.approval,
      words: [...new Set([...(base ? [] : [lower, ...lower.split(/\s+/).filter((w) => w.length > 3)]), ...words])], builtin: !!base,
    });
  }
  if (out.length > 20) throw new KindsError('At most 20 kinds of work.');
  if (!out.length) return null;
  return out;
}

/** Kunla's defaults as definitions. */
export const DEFAULT_DEFS: KindDef[] = DEFAULT_KINDS.map((k) => BUILTIN[k]);

/** The kinds that apply to a task: its project's list, else the workspace's, else the defaults. Other is always there. */
export function effectiveKinds(projectKinds: string | null | undefined, workspaceKinds: string | null | undefined): KindDef[] {
  const pick = (s: string | null | undefined) => { try { return s ? parseKinds(s) : null; } catch { return null; } };
  const list = pick(projectKinds) ?? pick(workspaceKinds) ?? DEFAULT_DEFS;
  return list.some((d) => d.key === 'other') ? list : [...list, BUILTIN.other];
}

/** Store form of a setting: only what differs from the built-in, so later improvements to defaults still reach it. */
export function storeKinds(defs: KindDef[] | null): string | null {
  if (!defs) return null;
  return JSON.stringify(defs.map((d) => {
    const b = d.builtin ? BUILTIN[d.key as BuiltinKind] : null;
    const o: Record<string, unknown> = { key: d.key, label: d.label };
    if (!b || d.hand_in !== b.hand_in) o.hand_in = d.hand_in;
    if (!b || d.approval !== b.approval) o.approval = d.approval;
    if (d.about && (!b || d.about !== b.about)) o.about = d.about;
    if (!b && d.words.length) o.words = d.words;
    return o;
  }));
}

/** Find a kind in a list from a key, a name, or a common word. Null if it isn't one of them. */
export function matchKind(defs: KindDef[], given: unknown): KindDef | null {
  if (typeof given !== 'string' || !given.trim()) return null;
  const s = given.trim().toLowerCase();
  const direct = defs.find((d) => d.key === s || d.label.toLowerCase() === s || slug(d.label) === slug(s));
  if (direct) return direct;
  const b = normalizeKind(s);
  return b ? defs.find((d) => d.key === b) ?? null : null;
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
  // Any code host: GitLab (gitlab.com or self-managed), GitHub Enterprise, Gitea/Forgejo, Bitbucket.
  if (/\/(-\/)?merge_requests\/\d+/.test(p) || /\/pull-requests\/\d+/.test(p)) return 'pr';
  if (/(^|[.-])(github|gitlab|gitea|forgejo|bitbucket)([.-]|$)/.test(h) || h === 'codeberg.org') {
    if (/\/pulls?\/\d+/.test(p)) return 'pr';
    if (/\/(-\/)?issues\/\d+/.test(p)) return 'issue';
  }
  if (h === 'huggingface.co' && p.startsWith('/papers')) return 'paper';
  if (PAPER_HOSTS.test(h)) return 'paper';
  if (h === 'docs.google.com') {
    if (p.startsWith('/spreadsheets')) return 'sheet';
    if (p.startsWith('/presentation')) return 'slides';
    if (p.startsWith('/forms')) return 'form';
    return 'doc';
  }
  if (h === 'claude.ai' || h.endsWith('.claude.ai')) return p.includes('/artifact') ? 'doc' : 'chat';
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

// Word cues per built-in kind, most specific first. Only a guess for tasks created without a kind.
const CUES: [BuiltinKind, RegExp][] = [
  ['learning', /\b(read(ing)?|papers?|preprint|literature|book|chapter|arxiv|learn(ing)?|study(ing)?|course|tutorial|understand|get up to speed|explore how|how does)\b/i],
  ['discussion', /\b(discuss(ion|ing)?|meeting|brainstorm(ing)?|debate|sync|1:1|one-on-one|talk (about|through)|call with|retro(spective)?|workshop)\b/i],
  ['outreach', /\b(marketing|campaign|launch|seo|ads?|social media|newsletter|linkedin|tweet|landing page|press release|announcement|go-to-market|gtm|webinar|sales|leads?|prospect(ing)?|deal|pipeline|outreach|pitch|demo for|customer call|renewal|rfp|partner(ship)?s?|event|conference)\b/i],
  ['research', /\b(market (research|scan|sizing|size)|size (the|a|our) market|tam|competitor|competitive|landscape|research|survey|benchmark|investigate|scan of|compare|dashboard|sql|query|metrics?|kpis?|dataset|data analysis|cohort|funnel|a\/b test|forecast|analy[sz]e)\b/i],
  ['writing', /\b(write|writing|draft|article|blog|post|essay|copy(writing)?|op-ed|whitepaper|white paper|documentation|docs|memo|readme|slides|deck)\b/i],
  ['design', /\b(design|mock-?ups?|wireframes?|figma|logo|prototype|ux|ui|brand(ing)?)\b/i],
  ['operations', /\b(plan(ning)?|budget|hire|hiring|recruit(ing)?|invoice|admin|onboard(ing)?|schedule|offsite|okrs?|roadmap|process|contract|legal|tax|payroll|expenses?|renew|subscription)\b/i],
  ['code', /\b(fix|bug|implement|refactor|api|endpoint|deploy|migration|tests?|build|ci|merge|pr|feature|webhook|worker|typescript|python|cli|sdk)\b/i],
];

// "prospecting" should match "prospects": drop a common ending when enough of the word is left.
const stem = (w: string) => w.split(' ').map((x) => { const t = x.replace(/(ing|ed|es|s)$/, ''); return t.length >= 4 ? t : x; }).join(' ');

/** Best guess at the kind of work among `defs` (default: Kunla's list) from title, brief and links. 'other' when nothing fits. */
export function inferKind(title: string, brief = '', urls: string[] = [], defs: KindDef[] = DEFAULT_DEFS): string {
  const has = (k: string) => defs.some((d) => d.key === k);
  const text = `${title}\n${brief.slice(0, 400)}`.toLowerCase();
  // The team's own kinds first: their name or words in the title, then in the brief.
  for (const where of [title.toLowerCase(), text]) {
    for (const d of defs) if (!d.builtin && d.words.some((w) => new RegExp(`\\b${stem(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(where))) return d.key;
  }
  // Built-in cues. A cue for a built-in kind the list doesn't have goes to the team's kind that stands in for it (e.g. "Sales" for outreach).
  const target = (b: BuiltinKind): string | null => {
    if (has(b)) return b;
    const stand = defs.find((d) => !d.builtin && (ALIAS[d.label.toLowerCase()] === b || d.words.some((w) => ALIAS[w] === b)));
    return stand ? stand.key : null;
  };
  const types = urls.map(linkType);
  if (types.some((t) => t === 'pr' || t === 'commit')) { const k = target('code'); if (k) return k; }
  if (types.includes('paper')) { const k = target('learning'); if (k) return k; }
  for (const where of [title, brief.slice(0, 400)]) {
    for (const [b, re] of CUES) if (re.test(where)) { const k = target(b); if (k) return k; }
  }
  return 'other';
}

/** One label for a key: from the list that applies, else Kunla's, else the key itself. */
export function labelFor(key: string, defs: KindDef[] = DEFAULT_DEFS): string {
  return defs.find((d) => d.key === key)?.label ?? KIND_LABEL[key] ?? (normalizeKind(key) ? KIND_LABEL[normalizeKind(key)!] : key.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()));
}
