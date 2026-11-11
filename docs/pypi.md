# Publishing to PyPI

The `kunla` package on PyPI (`pypi/`) is a thin wrapper: it installs a `kunla` command that runs the npm CLI, [`@spikinglabs/kunla`](npm.md), through `npx`. So `pip install kunla` or `uvx kunla` work for Python users, and the name `kunla` is ours on PyPI. It needs Node.js 18+ at run time.

The workflow `.github/workflows/publish-pypi.yml` builds it, checks that the installed command reports the right version, and publishes with PyPI trusted publishing (no token, no secret).

## First publish (once)

PyPI lets you register a trusted publisher for a project that doesn't exist yet (a "pending publisher"). Publishing then creates the project under your account.

1. Sign in at [pypi.org](https://pypi.org) (turn on two-factor authentication).
2. Go to **Your account → Publishing → Add a new pending publisher → GitHub**:
   - PyPI project name: `kunla`
   - Owner: `spikinglabs`
   - Repository name: `kunla`
   - Workflow name: `publish-pypi.yml`
   - Environment name: `pypi`
3. In GitHub: **spikinglabs/kunla → Settings → Environments → New environment** named `pypi`. Optionally add yourself as a required reviewer, so every PyPI release waits for your click.
4. **Actions → Publish to PyPI → Run workflow**, version `0.1.0`.

A pending publisher doesn't reserve the name by itself; the project exists once step 4 succeeds, so run it soon.

## Releasing later

Run the workflow with the new version, or push a tag: `git tag pypi-v0.2.0 && git push origin pypi-v0.2.0`. The wrapper runs the latest npm client by default, so it only needs a new release when the wrapper itself changes.
