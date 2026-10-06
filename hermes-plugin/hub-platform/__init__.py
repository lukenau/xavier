# SPDX-License-Identifier: MIT
"""Hub platform plugin entrypoint.

The gateway's plugin loader looks up one thing on this package: a module-level
``register(ctx)``. This plugin registers three things through it: the `hub`
platform adapter (``adapter.py``), the lifecycle hooks (``hooks.py``) and the
``hub_widget`` tool (``widget_tool.py``), a real ``register_tool``
registration rather than a fenced-block convention (see its module docstring).
"""

from .adapter import register as _register_platform
from .hooks import register_hooks as _register_hooks
from .widget_tool import register_widget_tool as _register_widget_tool


def register(ctx) -> None:
    _register_platform(ctx)
    _register_hooks(ctx)
    _register_widget_tool(ctx)


__all__ = ["register"]
