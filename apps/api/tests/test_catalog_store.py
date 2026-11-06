"""The API's catalog source: the newest stored row of every QPU with the newest stored queues; a
cheap live queue fetch when only the queues are old; a full live fetch (stored) when asked or when
nothing is confirmed recently; the old live path without a database."""

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import qrb_store
from qrb.live_status import LiveStatus, store_items
from qrb.snapshot import load_snapshot

from qrb_api import catalog_store

SNAPSHOT = Path(__file__).resolve().parents[3] / "scripts/experiments/output/shared_catalog_snapshot.json"
RECORDS = load_snapshot(SNAPSHOT)
AACHEN = next(r for r in RECORDS if r.resource_id == "ibm_aachen")


def now():
    return datetime.now(timezone.utc)


class FakeStore:
    """In-memory stand-in for the qrb_store catalog functions, with per-QPU fingerprint dedup."""

    def __init__(self):
        self.rows: list[dict] = []
        self.status: list[dict] = []
        self.loads = 0

    def latest(self):
        out = {}
        for r in self.rows:
            out[(r["provider_id"], r["resource_id"])] = r
        return out

    def record(self, items, *, checked_at, origin):
        latest = self.latest()
        added = 0
        for it in items:
            prev = latest.get((it["provider_id"], it["resource_id"]))
            if prev and prev["fingerprint"] == it["fingerprint"]:
                prev["checked_at"] = checked_at
                continue
            self.rows.append({**it, "id": len(self.rows) + 1, "checked_at": checked_at, "origin": origin})
            added += 1
        return added

    def metas(self, confirmed_since):
        return [
            qrb_store.CatalogResourceMeta(id=r["id"], provider_id=r["provider_id"], resource_id=r["resource_id"], fetched_at=r["fetched_at"], checked_at=r["checked_at"], fingerprint=r["fingerprint"])
            for r in self.latest().values()
            if r["checked_at"] >= confirmed_since
        ]

    def load(self, ids):
        self.loads += len(ids)
        return {r["id"]: r["payload"] for r in self.rows if r["id"] in ids}

    def record_status(self, statuses, *, fetched_at, origin):
        self.status.append({"id": len(self.status) + 1, "statuses": statuses, "fetched_at": fetched_at, "origin": origin})
        return len(self.status)

    def latest_status(self):
        if not self.status:
            return None
        s = self.status[-1]
        return qrb_store.CatalogStatus(id=s["id"], fetched_at=s["fetched_at"], origin=s["origin"], statuses=s["statuses"])

    def seed(self, records=RECORDS, *, age_min=4, status_age_min=None, queue=None):
        at = now() - timedelta(minutes=age_min)
        self.record(store_items(records, at), checked_at=at, origin="poller")
        if status_age_min is not None:
            self.record_status([LiveStatus("ibm_aachen", "ibm", queue, "active", True).to_dict()], fetched_at=now() - timedelta(minutes=status_age_min), origin="poller")


@pytest.fixture
def store(monkeypatch):
    fake = FakeStore()
    monkeypatch.setattr(qrb_store, "is_configured", lambda: True)
    monkeypatch.setattr(qrb_store, "record_catalog_resources", fake.record)
    monkeypatch.setattr(qrb_store, "latest_catalog_resources_meta", fake.metas)
    monkeypatch.setattr(qrb_store, "load_catalog_resources", fake.load)
    monkeypatch.setattr(qrb_store, "record_catalog_status", fake.record_status)
    monkeypatch.setattr(qrb_store, "latest_catalog_status", fake.latest_status)
    monkeypatch.setattr(catalog_store, "_decoded", {})
    monkeypatch.setattr(catalog_store, "_merged", None)
    monkeypatch.setenv("QRB_CATALOG_MAX_AGE_SECONDS", "900")
    monkeypatch.setenv("QRB_CALIBRATION_MAX_AGE_SECONDS", "7200")
    return fake


@pytest.fixture
def live(monkeypatch):
    calls = {"full": 0, "status": 0}

    def fetch(**kwargs):
        if kwargs.get("live") is False:
            return RECORDS, None, None
        calls["full"] += 1
        return RECORDS, False, now()

    def status(ids):
        calls["status"] += 1
        return [LiveStatus("ibm_aachen", "ibm", 41, "active", True)]

    monkeypatch.setattr(catalog_store, "fetch_catalog_timed", fetch)
    monkeypatch.setattr(catalog_store, "fetch_live_status", status)
    return calls


def aachen(records):
    return next(r for r in records if r.resource_id == "ibm_aachen")


def test_stored_qpus_and_queues_answer_without_asking_the_providers(store, live):
    store.seed(age_min=40, status_age_min=1, queue=123)
    records, hit, as_of = catalog_store.get_catalog()
    assert hit is True and len(records) == len(RECORDS)
    assert aachen(records).queue_length == 123
    assert abs((as_of - (now() - timedelta(minutes=1))).total_seconds()) < 5
    assert live == {"full": 0, "status": 0}
    catalog_store.get_catalog(providers=["ibm"])
    assert store.loads == len(RECORDS)  # every row decoded once


def test_one_recalibrated_qpu_is_one_new_row_and_only_it_is_decoded_again(store, live):
    store.seed(age_min=10, status_age_min=1, queue=5)
    catalog_store.get_catalog()
    loads = store.loads
    newer = replace(AACHEN, last_calibrated_at=AACHEN.last_calibrated_at + timedelta(hours=3))
    store.record(store_items([newer], now()), checked_at=now(), origin="poller")
    assert len(store.rows) == len(RECORDS) + 1
    records, hit, _ = catalog_store.get_catalog()
    assert hit is True and aachen(records).last_calibrated_at == newer.last_calibrated_at
    assert store.loads == loads + 1


def test_unchanged_calibration_only_confirms_rows(store, live):
    store.seed(age_min=10)
    store.record(store_items(RECORDS, now()), checked_at=now(), origin="poller")
    assert len(store.rows) == len(RECORDS)


def test_old_queues_trigger_only_a_queue_fetch(store, live):
    store.seed(age_min=40, status_age_min=20, queue=5)
    records, hit, _ = catalog_store.get_catalog()
    assert hit is False and aachen(records).queue_length == 41
    assert live == {"full": 0, "status": 1}
    records, hit, _ = catalog_store.get_catalog()
    assert hit is True and aachen(records).queue_length == 41 and live["status"] == 1


def test_a_qpu_not_confirmed_recently_drops_out(store, live):
    store.seed(age_min=180)  # everything old...
    store.seed([r for r in RECORDS if r.resource_id != "ibm_aachen"], age_min=1, status_age_min=1, queue=1)  # ...then confirmed, except aachen
    records, hit, _ = catalog_store.get_catalog()
    assert hit is True and "ibm_aachen" not in {r.resource_id for r in records}


def test_nothing_confirmed_fetches_everything_and_stores_it(store, live):
    store.seed(age_min=180, status_age_min=1, queue=5)
    _, hit, _ = catalog_store.get_catalog()
    assert hit is False and live["full"] == 1
    assert len(store.rows) == len(RECORDS)  # same calibrations: confirmed, not re-added
    _, hit, _ = catalog_store.get_catalog()
    assert hit is True and live["full"] == 1


def test_force_refresh_always_fetches_whole(store, live):
    store.seed(age_min=1, status_age_min=1, queue=5)
    _, hit, _ = catalog_store.get_catalog(force_refresh=True)
    assert hit is False and live == {"full": 1, "status": 0}


def test_queue_rows_older_than_the_qpus_are_ignored(store, live):
    store.record_status([LiveStatus("ibm_aachen", "ibm", 999, "active", True).to_dict()], fetched_at=now() - timedelta(minutes=10), origin="poller")
    store.seed(age_min=2)
    records, hit, _ = catalog_store.get_catalog()
    assert hit is True and aachen(records).queue_length == AACHEN.queue_length


def test_snapshot_mode_never_touches_the_store(store, live):
    _, hit, fetched_at = catalog_store.get_catalog(live=False, snapshot_path=SNAPSHOT)
    assert hit is None and fetched_at is None and store.rows == []


def test_without_a_database_the_live_path_is_unchanged(monkeypatch, live):
    monkeypatch.setattr(qrb_store, "is_configured", lambda: False)
    catalog_store.get_catalog(providers=["ibm"])
    assert live == {"full": 1, "status": 0}


def test_an_unreachable_database_falls_back_to_a_live_fetch(store, live, monkeypatch):
    def broken(since):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(qrb_store, "latest_catalog_resources_meta", broken)
    _, hit, _ = catalog_store.get_catalog()
    assert hit is False and live["full"] == 1 and store.rows == []
