"""Run the Kunla CLI (npm package @spikinglabs/kunla) with the given arguments."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys

from kunla import NPM_PACKAGE, __version__

HELP = f"""kunla {__version__} (Python wrapper)

Runs the Kunla command-line client, {NPM_PACKAGE} on npm, through npx.
It needs Node.js 18 or newer: https://nodejs.org

  kunla login            connect this machine to your Kunla
  kunla --help           all commands of the client

Docs: https://github.com/spikinglabs/kunla
Set KUNLA_NPM_VERSION to pin a client version (default: latest)."""


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args[:1] == ["--wrapper-version"]:
        print(__version__)
        return 0
    npx = shutil.which("npx")
    if npx is None:
        print(HELP, file=sys.stderr)
        print("\nnpx was not found. Install Node.js 18+ and try again.", file=sys.stderr)
        return 127
    spec = f"{NPM_PACKAGE}@{os.environ.get('KUNLA_NPM_VERSION', 'latest')}"
    try:
        return subprocess.call([npx, "--yes", spec, *args])
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
