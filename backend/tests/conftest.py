"""Minimal pytest bootstrap — the repo had no test harness, so this puts the
gateway service packages on sys.path the way the Docker image does. Run from
repo root:

    pip install pytest pytest-asyncio
    pytest backend/tests -q

Note: importing the service pulls in the full models package, so a DATABASE_URL
(or the project's default) must be importable. These tests mock the DB session
and never open a real connection.
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.abspath(os.path.join(_HERE, ".."))

# `backend/` so `packages.common.src.*` resolves; gateway `src` so `services.*`
# resolves (mirrors the gateway container's PYTHONPATH).
for p in (_BACKEND, os.path.join(_BACKEND, "services", "gateway", "src")):
    if p not in sys.path:
        sys.path.insert(0, p)
