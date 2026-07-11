"""Guard-logic tests for the personal deposit-request feature (migration 0082).

The repo has no DB test harness, so these mock the AsyncSession and assert the
validation / state guards — the parts most likely to regress. The happy-path
request -> approve -> visible flow is covered by the manual plan in the PR.

    pip install pytest pytest-asyncio
    pytest backend/tests/test_deposit_requests.py -q
"""
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest
from fastapi import HTTPException

from services import deposit_request_service as gw

# asyncio_mode=auto (see pytest.ini) runs the async tests; no per-test marker.


def _db_with_first(first_value):
    """An AsyncSession whose db.execute(...).first() returns `first_value`.
    db.add is sync in SQLAlchemy, so keep it a plain MagicMock (no stray
    un-awaited coroutine warning)."""
    db = AsyncMock()
    db.add = MagicMock()
    result = MagicMock()
    result.first.return_value = first_value
    result.scalars.return_value.all.return_value = []
    db.execute.return_value = result
    return db


async def test_create_rejects_non_positive_amount():
    db = AsyncMock()
    for bad in (0, -5, None):
        with pytest.raises(HTTPException) as e:
            await gw.create_request(uuid4(), bad, db)
        assert e.value.status_code == 400
    db.commit.assert_not_called()


async def test_create_blocks_duplicate_pending():
    # An existing pending row → second request is rejected with 409.
    db = _db_with_first((uuid4(),))
    with pytest.raises(HTTPException) as e:
        await gw.create_request(uuid4(), Decimal("100"), db)
    assert e.value.status_code == 409


async def test_create_succeeds_when_no_pending():
    db = _db_with_first(None)  # no existing pending
    out = await gw.create_request(uuid4(), Decimal("100"), db)
    assert out["status"] == "pending"
    assert out["amount"] == 100.0
    db.add.assert_called()       # a DepositRequest was added
    db.commit.assert_awaited()   # and committed


def test_serialize_exposes_admin_reply():
    r = SimpleNamespace(
        id=uuid4(), amount=Decimal("50"), status="approved",
        admin_qr="data:image/png;base64,AAA", admin_bank_text="ACC 123",
        admin_upi="x@upi", admin_note="pay here", created_at=None, responded_at=None,
    )
    out = gw._serialize(r)
    assert out["status"] == "approved"
    assert out["admin_upi"] == "x@upi"
    assert out["admin_qr"].startswith("data:image")
