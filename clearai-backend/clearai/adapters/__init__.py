"""Adapters — concrete implementations of ports.

V1 has one: AnthropicReasoner. Adding a second provider (Azure AI Foundry,
a different vendor, an offline model) is an additive change here; nothing
in services/ or ports/ moves.
"""

from clearai.adapters.anthropic_reasoner import AnthropicReasoner

__all__ = ["AnthropicReasoner"]
