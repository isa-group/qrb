"""Sync SQLAlchemy engine/session, lazily built from DATABASE_URL. Nothing
here runs at import time — record_binding()/record_telemetry_sample() are
meant to work in processes that never configure Postgres at all.
"""

from __future__ import annotations

import logging
import os
import threading

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker

logger = logging.getLogger(__name__)

_engine: Engine | None = None
_session_factory: sessionmaker[Session] | None = None
_lock = threading.Lock()
_warned_missing_url = False


def is_configured() -> bool:
    return bool(os.environ.get("DATABASE_URL"))


def get_session_factory() -> sessionmaker[Session] | None:
    """None if DATABASE_URL isn't set — callers treat that as "skip
    persistence", not an error."""
    global _engine, _session_factory, _warned_missing_url

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        if not _warned_missing_url:
            logger.warning("DATABASE_URL not set — historical data will not be recorded.")
            _warned_missing_url = True
        return None

    with _lock:
        if _session_factory is None:
            _engine = create_engine(database_url, pool_pre_ping=True)
            _session_factory = sessionmaker(bind=_engine, expire_on_commit=False)
        return _session_factory
