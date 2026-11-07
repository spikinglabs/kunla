# Kunla landing page

A single static page (`index.html`): plain HTML, CSS and inline SVG, no build step and no JavaScript. Fonts come from Google Fonts.

Preview locally by opening `site/index.html` in a browser.

Deploy to Cloudflare Pages (free):

```sh
npx wrangler pages deploy site --project-name kunla-site
```

Then add a custom domain to the Pages project in the Cloudflare dashboard. The app itself is served separately by the Worker (`public/`).

Example names and numbers on the page (Maya, Jon, Priya, the six-week chart) are illustrative and labelled as such. The hosting estimate assumes 5 people and 4 agents.
