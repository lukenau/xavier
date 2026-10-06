"""Test-wide settings, loaded by pytest before any test module imports `app`.

FastAPI's TestClient sends `Host: testserver`. The server refuses hostnames it was
not told about (HostAllowlistMiddleware in app.py), so the tests name that one.
"""
import os

os.environ.setdefault("HUB_ALLOWED_HOSTS", "testserver")
