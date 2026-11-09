# Publishing the CLI to npm

The `@spikinglabs/kunla` package on npm is the command-line client (npm refuses the plain name `kunla` as too similar to `konva`; the installed command is still `kunla`) (`plugins/claude-code/bin/kunla.mjs`, no dependencies). The server is not published to npm; it deploys from this repository. The workflow `.github/workflows/publish-npm.yml` builds the package from `npm/package.json` and publishes it.

## First publish (once)

npm only lets you set up token-free publishing on a package that already exists, so the first release uses a short-lived token.

1. Sign in at [npmjs.com](https://www.npmjs.com) (create a free account if needed, and turn on two-factor authentication).
2. Your account needs two-factor authentication turned on, or npm drops the token's bypass setting and refuses to publish. The package goes in the `spikinglabs` org, so the token needs write access to it.
3. Create a token: avatar → **Access Tokens** → **Generate New Token** → **Granular Access Token**. Packages and scopes: **Read and write**, **All packages**. A 7-day expiry is plenty. If npm offers "Bypass two-factor authentication", tick it so Actions can publish.
4. In GitHub: **spikinglabs/kunla → Settings → Secrets and variables → Actions → New repository secret**, name `NPM_TOKEN`, paste the token.
5. **Actions → Publish CLI to npm → Run workflow**, version `0.1.0`.

## Then switch to trusted publishing (no token)

1. On npmjs.com open the `@spikinglabs/kunla` package → **Settings** → **Trusted Publisher** → **GitHub Actions**: organization `spikinglabs`, repository `kunla`, workflow `publish-npm.yml`, no environment. These fields are case-sensitive.
2. Optional, same page: **Publishing access** → require two-factor authentication and disallow tokens.
3. Delete the `NPM_TOKEN` secret in GitHub and revoke the token on npmjs.com.

## Releasing later

Run the workflow with the new version, or push a tag: `git tag cli-v0.2.0 && git push origin cli-v0.2.0`. Once the repository is public, every release also carries npm provenance linking it to the commit and workflow run (npm refuses provenance from private repositories).
