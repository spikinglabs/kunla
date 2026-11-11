"""Kunla: the team's record of work, shared by people and AIs.

This package installs the ``kunla`` command for Python environments. The CLI
itself is the Node.js client published on npm as ``@spikinglabs/kunla``; this
wrapper runs it through ``npx`` so ``pip install kunla`` and ``uvx kunla`` work.
"""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("kunla")
except PackageNotFoundError:  # running from a source checkout
    __version__ = "0.0.0"

NPM_PACKAGE = "@spikinglabs/kunla"
