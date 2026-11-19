#!/usr/bin/env node
// Builds the guides in docs/ into plain web pages under public/docs/ (KD-92), so every Kunla serves its own
// manual at /docs/: staging, Kunla Cloud (kunla.app/docs/) and self-hosted copies, with no extra hosting.
// The pages are committed, so the Deploy button, `wrangler deploy` and the Kunla Cloud release bundle all pick
// them up without a build step. `npm run docs` rebuilds them; `npm run docs:check` (in CI) fails when they are stale.
import { Marked } from 'marked';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'docs');
const out = join(root, 'public', 'docs');
const REPO = 'https://github.com/spikinglabs/kunla';
const CANONICAL = 'https://kunla.app';
const check = process.argv.includes('--check');

// The sidebar, in reading order. Every .md file under docs/ becomes a page; ones not listed here go last.
const NAV = [
  { title: 'Start here', pages: [['README.md', 'Overview']] },
  { title: 'Guides', pages: [['using-kunla.md', 'Using Kunla'], ['connect-ai.md', 'Connect your AI'], ['self-hosting.md', 'Self-hosting']] },
  { title: 'Other agents', pages: [['agents/codex.md', 'Codex'], ['agents/open-source.md', 'Open-source agents']] },
  { title: 'Maintainers', pages: [['npm.md', 'Publishing to npm'], ['pypi.md', 'Publishing to PyPI']] },
];

const mdFiles = (dir) => readdirSync(dir).sort().flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? mdFiles(p) : f.endsWith('.md') ? [relative(src, p).split('\\').join('/')] : [];
});
const files = mdFiles(src);
const listed = new Set(NAV.flatMap((s) => s.pages.map(([f]) => f)));
const extra = files.filter((f) => !listed.has(f));
if (extra.length) NAV.push({ title: 'More', pages: extra.map((f) => [f, null]) });
for (const f of listed) if (!files.includes(f)) throw new Error(`docs nav lists ${f}, which does not exist`);

/** docs/using-kunla.md -> /docs/using-kunla/, docs/README.md -> /docs/ */
const urlOf = (file) => '/docs/' + file.replace(/(^|\/)README\.md$/, '$1').replace(/\.md$/, '/');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const strip = (html) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
// GitHub's heading anchors, so links written for GitHub (#what-a-tasks-status-means) work here too.
const slug = (text) => strip(text).trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

/** A link as written in a guide, made to work on the site: other guides become pages, repo files go to GitHub. */
function rewrite(href, from) {
  if (!href || /^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) return href;
  const [path, hash = ''] = href.split('#');
  const target = posix.normalize(posix.join(posix.dirname(from), path));
  const frag = hash ? '#' + hash : '';
  if (target.endsWith('.md') && files.includes(target)) return urlOf(target) + frag;
  if (target.startsWith('../')) return `${REPO}/blob/main/${target.slice(3)}${frag}`;
  return `${REPO}/blob/main/docs/${target}${frag}`;
}

function render(file) {
  const md = readFileSync(join(src, file), 'utf8');
  const seen = new Map();
  const toc = [];
  let title = '';
  const renderer = {
    heading({ tokens, depth }) {
      const inner = this.parser.parseInline(tokens);
      let id = slug(inner);
      const n = seen.get(id) ?? 0;
      seen.set(id, n + 1);
      if (n) id += '-' + n;
      if (depth === 1 && !title) title = strip(inner);
      if (depth === 2) toc.push([id, strip(inner)]);
      return `<h${depth} id="${id}">${inner}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>\n`;
    },
    link({ href, title: t, tokens }) {
      const h = rewrite(href, file);
      const ext = /^https?:/.test(h) && !h.startsWith(CANONICAL);
      return `<a href="${esc(h)}"${t ? ` title="${esc(t)}"` : ''}${ext ? ' rel="noopener"' : ''}>${this.parser.parseInline(tokens)}</a>`;
    },
  };
  const m = new Marked({ gfm: true });
  m.use({ renderer });
  // Wide tables scroll sideways on a phone instead of widening the page.
  const body = m.parse(md).replace(/<table>/g, '<div class="table"><table>').replace(/<\/table>/g, '</table></div>');
  return { body, title: title || file, toc };
}

const description = (body) => {
  const p = body.match(/<p>([\s\S]*?)<\/p>/);
  return p ? strip(p[1]).replace(/\s+/g, ' ').slice(0, 200) : 'Kunla documentation';
};

function page(file, { body, title, toc }) {
  const url = urlOf(file);
  const nav = NAV.map((s) => `<div class="group"><p class="eyebrow">${esc(s.title)}</p><ul>${s.pages.map(([f, label]) => {
    const here = f === file;
    return `<li><a href="${urlOf(f)}"${here ? ' aria-current="page"' : ''}>${esc(label || render(f).title)}</a></li>`;
  }).join('')}</ul></div>`).join('');
  const onPage = toc.length > 2 ? `<nav class="toc" aria-label="On this page"><p class="eyebrow">On this page</p><ul>${toc.map(([id, t]) => `<li><a href="#${id}">${esc(t)}</a></li>`).join('')}</ul></nav>` : '';
  return `<!doctype html>
<!-- Generated from docs/${file} by scripts/build-docs.mjs. Edit the Markdown, then run npm run docs. -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)} · Kunla docs</title>
<meta name="description" content="${esc(description(body))}">
<link rel="canonical" href="${CANONICAL}${url}">
<script src="/theme.js"></script>
<link rel="icon" href="/icons/icon-192.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/docs/docs.css">
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="top">
  <a class="logo" href="/" aria-label="Kunla home">kunla<i></i></a>
  <a class="section" href="/docs/">Docs</a>
  <span class="spacer"></span>
  <button class="theme-btn" id="theme" type="button" aria-label="Theme"></button>
  <a class="btn ghost" href="${REPO}">GitHub</a>
  <a class="btn" href="/app/">Open Kunla</a>
</header>
<div class="layout">
  <details class="side" open>
    <summary>Guides</summary>
    <nav aria-label="Guides">${nav}</nav>
  </details>
  <main id="content">
    <article>
${body}
    </article>
    <p class="edit"><a href="${REPO}/edit/main/docs/${file}">Edit this page on GitHub</a> · <a href="${REPO}/issues/new">Report a problem</a></p>
  </main>
  ${onPage}
</div>
<footer>Kunla is open source (Apache-2.0), made by <a href="https://spikinglabs.com">Spiking Labs</a>. These pages come with every Kunla, so they match the version you run.</footer>
<script>
  window.kunlaTheme && kunlaTheme.bindButton(document.getElementById('theme'));
  // Phones start with the guide list folded away; wide screens keep it open as a sidebar.
  if (matchMedia('(max-width: 899px)').matches) document.querySelector('.side').removeAttribute('open');
</script>
</body>
</html>
`;
}

const want = new Map();
for (const f of files) want.set(join(out, urlOf(f).slice('/docs/'.length), 'index.html'), page(f, render(f)));
want.set(join(out, 'docs.css'), readFileSync(join(root, 'scripts', 'docs.css'), 'utf8'));

if (check) {
  const have = existsSync(out) ? (function walk(d) { return readdirSync(d).flatMap((f) => statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]); })(out) : [];
  const stale = [...want].filter(([p, s]) => !existsSync(p) || readFileSync(p, 'utf8') !== s).map(([p]) => p);
  const orphans = have.filter((p) => !want.has(p));
  if (stale.length || orphans.length) {
    console.error('The docs pages in public/docs are out of date. Run `npm run docs` and commit the result.');
    for (const p of [...stale, ...orphans]) console.error('  ' + relative(root, p));
    process.exit(1);
  }
  console.log(`Docs pages are up to date (${want.size} files).`);
} else {
  rmSync(out, { recursive: true, force: true });
  for (const [p, s] of want) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); }
  console.log(`Built ${want.size - 1} docs pages into public/docs/.`);
}
