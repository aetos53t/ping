"""
PING - Agent-to-Agent Messenger SDK

Simple A2A communication for AI agents.
"""

from .client import PingClient, PingError

__version__ = "0.1.0"
__all__ = ["PingClient", "PingError", "__version__"]
