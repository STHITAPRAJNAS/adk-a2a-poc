"""Release-operations agent package.

ADK's agent loader puts ``remote_agents/`` on ``sys.path`` and imports this
directory as the top-level package ``deployment_agent``, so everything inside it
uses relative imports. Shared modules (``common.*``) are imported absolutely and
resolve against the repo root, which the server entry point puts on the path.
"""

from . import agent  # noqa: F401
from .agent import app, root_agent  # noqa: F401

__all__ = ["agent", "app", "root_agent"]
