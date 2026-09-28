"""Smoke test run by `task test`: the RQ1 BIM instances validate against the
OpenBinding schema and their offline optimum matches the paper."""

import json

import pytest
from openbinding import Instance

from verify_bim_instances import BIM_DIR, EXPECTED, solve

INSTANCES = sorted([*BIM_DIR.glob("fms_*.json"), *BIM_DIR.glob("experiment3_*.json")])


@pytest.mark.parametrize("path", INSTANCES, ids=lambda p: p.name)
def test_instance_is_valid_bim(path):
    Instance.model_validate(json.loads(path.read_text()))


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_offline_optimum_matches_paper(name):
    binding, _ = solve(json.loads((BIM_DIR / name).read_text()))
    assert binding == EXPECTED[name]
