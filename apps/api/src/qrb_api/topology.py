"""A device's qubit topology for the catalog: the coupling map, per-qubit and per-coupler errors,
and 2D coordinates to draw it.

Everything is read from the resource's Qiskit Target with the same rules as
qrb.calibration.calibration_summary, so a qubit's figures here agree with the device medians:
readout error from measure*, single-qubit error as the median over that qubit's 1q gates,
two-qubit error per undirected coupler as the mean over both directions and every 2q gate.

The data carries no coordinates. Devices numbered along rows (IBM heavy hex and Nighthawk, most
square lattices) are drawn the way their provider draws them, rows of qubits with bridges between;
other sparse devices get a deterministic Kamada-Kawai layout seeded from a spectral layout, so lattices read as lattices; all-to-all devices (trapped ions)
get a ring. A layout is computed once per device and cached, keyed by the device id and its
coupling map, so it is recomputed only if the wiring changes.
"""

from __future__ import annotations

import hashlib
import math
import statistics
from typing import Optional

import networkx as nx
from pydantic import BaseModel

from qrb.calibration import _CONTROL_FLOW_OPERATIONS

_SKIP = frozenset({"delay", "barrier"}) | _CONTROL_FLOW_OPERATIONS


class CalibrationField(BaseModel):
    id: str
    label: str
    """As the provider names it, e.g. "T1 (µs)", "√x (sx) error", "CZ error"."""
    unit: str
    """"error" (a probability, shown as a percentage), "us", "ns", "ghz", "s" or ""."""
    better: Optional[str] = None
    """"lower", "higher" or None (frequency, anharmonicity)."""


class TopologyQubit(BaseModel):
    index: int
    x: float
    """0..1 across the drawing; y uses the same scale, so the aspect is kept."""
    y: float
    readout_error: Optional[float]
    error_1q: Optional[float]
    values: dict[str, Optional[float]] = {}
    """Every per-qubit field the provider reports, keyed by CalibrationField.id."""


class TopologyCoupler(BaseModel):
    a: int
    b: int
    error_2q: Optional[float]
    values: dict[str, Optional[float]] = {}


class DeviceValue(BaseModel):
    field: CalibrationField
    value: Optional[float]


class Topology(BaseModel):
    candidate_id: str
    num_qubits: int
    all_to_all: bool
    """Every pair of qubits couples directly (trapped ions). Couplers are then omitted: there are
    n(n-1)/2 of them and, on these devices, no per-pair errors."""
    layout: str
    """"rows" (the provider's own row drawing), "kamada-kawai" or "ring"."""
    width: float
    height: float
    """Extent of the coordinates (the longer side is 1)."""
    processor: Optional[str] = None
    qubit_fields: list[CalibrationField] = []
    coupler_fields: list[CalibrationField] = []
    medians: dict[str, Optional[float]] = {}
    """Median of each qubit and coupler field over the device."""
    device: list[DeviceValue] = []
    """Device-wide figures for providers that report no per-qubit data (IonQ, AQT)."""
    qubits: list[TopologyQubit]
    couplers: list[TopologyCoupler]


_layout_cache: dict[tuple[str, str], dict[int, tuple[float, float]]] = {}


def _median(values: list[float]) -> Optional[float]:
    return statistics.median(values) if values else None


def _crossings(pos: dict[int, tuple[float, float]], edges: list[tuple[int, int]]) -> int:
    def ccw(a, b, c):
        return (c[1] - a[1]) * (b[0] - a[0]) > (b[1] - a[1]) * (c[0] - a[0])
    n = 0
    for i, (a, b) in enumerate(edges):
        for c, d in edges[i + 1 :]:
            if len({a, b, c, d}) < 4:
                continue
            A, B, C, D = pos[a], pos[b], pos[c], pos[d]
            if ccw(A, C, D) != ccw(B, C, D) and ccw(A, B, C) != ccw(A, B, D):
                n += 1
                if n > 0:
                    return n
    return n


def _row_layout(n: int, edges: list[tuple[int, int]]) -> Optional[dict[int, tuple[float, float]]]:
    """The provider's own drawing, where it numbers along rows (IBM heavy hex and Nighthawk, most
    square lattices): maximal runs of consecutively coupled qubits are rows; the other qubits are
    bridges between two rows; each row is shifted so that coupled qubits line up. None when the
    device does not follow that pattern, or the drawing would have crossing couplers."""
    es = set(edges)
    adj: dict[int, set[int]] = {i: set() for i in range(n)}
    for a, b in edges:
        adj[a].add(b)
        adj[b].add(a)
    rows: list[list[int]] = []
    i = 0
    while i < n:
        j = i
        while (j, j + 1) in es:
            j += 1
        if j - i >= 2:
            rows.append(list(range(i, j + 1)))
        i = j + 1
    in_row = {q: (r, c) for r, row in enumerate(rows) for c, q in enumerate(row)}
    if len(in_row) < 0.6 * n or len(rows) < 2:
        return None
    bridges = [q for q in range(n) if q not in in_row]
    # A real bridge (heavy hex) couples only to row qubits, in two different rows; a lattice that
    # is not numbered along rows (IQM) fails this and keeps the force layout.
    for b in bridges:
        if not adj[b] or any(m not in in_row for m in adj[b]) or len({in_row[m][0] for m in adj[b]}) != 2:
            return None
    offset: dict[int, float] = {0: 0.0}
    for r in range(1, len(rows)):
        cands: list[float] = []
        for c, q in enumerate(rows[r]):
            # direct couplers to an earlier row, or through a bridge qubit
            links = [(m, 0) for m in adj[q] if m in in_row and in_row[m][0] < r]
            for b in adj[q]:
                if b in in_row:
                    continue
                links += [(m, 1) for m in adj[b] if m in in_row and in_row[m][0] < r]
            for m, _ in links:
                pr, pc = in_row[m]
                if pr in offset:
                    cands.append(offset[pr] + pc - c)
        if not cands:
            return None
        offset[r] = statistics.median(cands)
    gap = 2.0 if bridges else 1.0
    pos = {q: (offset[r] + c, r * gap) for q, (r, c) in in_row.items()}
    for b in bridges:
        nb = [pos[m] for m in adj[b] if m in pos]
        if not nb:
            return None
        pos[b] = (statistics.fmean(p[0] for p in nb), statistics.fmean(p[1] for p in nb) if len(nb) > 1 else nb[0][1] + gap / 2)
    if len(pos) != n or _crossings(pos, edges):
        return None
    return pos


def _orient(pos: dict[int, tuple[float, float]], edges: list[tuple[int, int]]) -> dict[int, tuple[float, float]]:
    """Square the drawing up the way a provider's own map reads: one family of couplers horizontal
    (rotate by the dominant edge angle, folded to 90 or 60 degrees), then the one of the eight rotations and
    flips that puts qubit 0 top-left with qubit 1 to its right (wider than tall breaks ties)."""
    # Square lattices have edges 90 degrees apart, hexagonal ones (IBM heavy hex) 60 degrees apart:
    # fold the edge angles both ways and use whichever symmetry the device actually has.
    best = (0.0, 0.0)
    for k in (4, 6):
        sx = sy = 0.0
        for a, b in edges:
            dx, dy = pos[b][0] - pos[a][0], pos[b][1] - pos[a][1]
            if dx or dy:
                t = k * math.atan2(dy, dx)
                sx, sy = sx + math.cos(t), sy + math.sin(t)
        strength = math.hypot(sx, sy) / max(len(edges), 1)
        if strength > best[0]:
            best = (strength, -math.atan2(sy, sx) / k)
    rot = best[1]
    # Providers that number along rows (IBM: 0-15 is heavy hex's first row; Nighthawk 0-9) have
    # 0-1-2-3-4 as a chain: lay that chain horizontally instead.
    es = set(edges)
    k = 0
    while (k, k + 1) in es and k + 1 in pos:
        k += 1
    if k >= 4:  # the whole first row, 0..k, not just its first few qubits
        dx, dy = pos[k][0] - pos[0][0], pos[k][1] - pos[0][1]
        if dx or dy:
            rot = -math.atan2(dy, dx)
    c, s_ = math.cos(rot), math.sin(rot)
    base = {i: (x * c - y * s_, x * s_ + y * c) for i, (x, y) in pos.items()}

    def variants():
        for swap in (False, True):
            for fx in (1, -1):
                for fy in (1, -1):
                    yield {i: ((y if swap else x) * fx, (x if swap else y) * fy) for i, (x, y) in base.items()}

    def score(p):
        xs = [v[0] for v in p.values()]
        ys = [v[1] for v in p.values()]
        w, h = (max(xs) - min(xs)) or 1.0, (max(ys) - min(ys)) or 1.0
        x0, y0 = (p[0][0] - min(xs)) / w, (p[0][1] - min(ys)) / h
        right = ((p[1][0] - p[0][0]) / w) if 1 in p else 0.0
        # Reading order first (qubit 0 top-left, qubit 1 to its right, as providers number them),
        # then wider than tall as a tiebreak.
        return (round(-(x0 + y0) + 2 * right, 3), w >= h * 0.95)

    return max(variants(), key=score)


def _layout(candidate_id: str, n: int, edges: list[tuple[int, int]], all_to_all: bool) -> tuple[str, dict[int, tuple[float, float]]]:
    kind = "ring" if all_to_all or not edges else "kamada-kawai"
    key = (candidate_id, hashlib.sha1(repr((n, kind, sorted(edges), "oriented-v8")).encode()).hexdigest())
    if key in _layout_cache:
        return kind, _layout_cache[key]
    if kind == "ring":
        pos = {i: (math.cos(2 * math.pi * i / n - math.pi / 2), math.sin(2 * math.pi * i / n - math.pi / 2)) for i in range(n)}
    elif (rowpos := _row_layout(n, edges)) is not None:
        kind, pos = "rows", rowpos
    else:
        g = nx.Graph()
        g.add_nodes_from(range(n))
        g.add_edges_from(edges)
        # Kamada-Kawai seeded from a spectral layout: deterministic, and it unfolds the lattices
        # without crossings (plain Kamada-Kawai folded IBM's heavy hex over itself: 6 crossings,
        # against 0 seeded, on every device in the snapshot). A disconnected map, where the
        # spectral step can fail, falls back to plain Kamada-Kawai.
        try:
            raw = nx.kamada_kawai_layout(g, pos=nx.spectral_layout(g))
        except Exception:
            raw = nx.kamada_kawai_layout(g)
        pos = {int(k): (float(v[0]), float(v[1])) for k, v in raw.items()}
    if kind == "kamada-kawai" and edges:
        pos = _orient(pos, edges)
    # Normalise to a box whose longer side is 1, keeping the aspect.
    xs = [p[0] for p in pos.values()]
    ys = [p[1] for p in pos.values()]
    span = max(max(xs) - min(xs), max(ys) - min(ys)) or 1.0
    norm = {i: ((x - min(xs)) / span, (y - min(ys)) / span) for i, (x, y) in pos.items()}
    _layout_cache[key] = norm
    return kind, norm


# ---------- per-qubit calibration fields ----------

_GATE_LABELS = {"id": "ID error", "rz": "Z-axis rotation (rz) error", "sx": "√x (sx) error", "x": "Pauli-X error", "rx": "RX error", "r": "R error"}


def _gate_label(name: str) -> str:
    return _GATE_LABELS.get(name.lower(), f"{name.upper()} error" if len(name) <= 6 else f"{name} error")


def _f(id: str, label: str, unit: str, better: Optional[str]) -> CalibrationField:
    return CalibrationField(id=id, label=label, unit=unit, better=better)


def _num(v) -> Optional[float]:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def _ibm_fields(resource, n: int):
    """IBM: qubit parameters from BackendProperties (live), or from the Target where the snapshot
    has them; every gate's error and length from the Target."""
    target = resource.target
    q: dict[int, dict[str, Optional[float]]] = {i: {} for i in range(n)}
    c: dict[tuple[int, int], dict[str, Optional[float]]] = {}
    qf: dict[str, CalibrationField] = {}
    cf: dict[str, CalibrationField] = {}
    props = getattr(resource, "ibm_properties", None)
    PARAMS = [("T1", "t1_us", "T1 (µs)", "us", "higher"), ("T2", "t2_us", "T2 (µs)", "us", "higher"),
              ("frequency", "frequency_ghz", "Frequency (GHz)", "ghz", None), ("anharmonicity", "anharmonicity_ghz", "Anharmonicity (GHz)", "ghz", None),
              ("readout_error", "readout_error", "Readout assignment error", "error", "lower"),
              ("prob_meas0_prep1", "prob_meas0_prep1", "Prob meas0 prep1", "error", "lower"),
              ("prob_meas1_prep0", "prob_meas1_prep0", "Prob meas1 prep0", "error", "lower"),
              ("readout_length", "readout_length_ns", "Readout length (ns)", "ns", "lower")]
    if props is not None:
        for i, params in enumerate(getattr(props, "qubits", []) or []):
            if i >= n:
                break
            by = {p.name: p for p in params}
            for name, fid, label, unit, better in PARAMS:
                p = by.get(name)
                if p is None:
                    continue
                v = _num(p.value)
                u = (getattr(p, "unit", "") or "").lower()
                if v is not None and fid.endswith("_us") and u == "ns":
                    v /= 1000
                if v is not None and fid.endswith("_ns") and u == "us":
                    v *= 1000
                if v is not None and fid.endswith("_ghz") and u == "mhz":
                    v /= 1000
                q[i][fid] = v
                qf.setdefault(fid, _f(fid, label, unit, better))
    else:
        for i, qp in enumerate(target.qubit_properties or []):
            if qp is None or i >= n:
                continue
            for attr, fid, label, unit, better, k in [("t1", "t1_us", "T1 (µs)", "us", "higher", 1e6), ("t2", "t2_us", "T2 (µs)", "us", "higher", 1e6), ("frequency", "frequency_ghz", "Frequency (GHz)", "ghz", None, 1e-9)]:
                v = _num(getattr(qp, attr, None))
                if v is not None:
                    q[i][fid] = v * k
                    qf.setdefault(fid, _f(fid, label, unit, better))
    gate_len_1q: dict[int, float] = {}
    for name in sorted(target.operation_names):
        if name in _SKIP or name.startswith("reset"):
            continue
        try:
            items = target[name].items()
        except KeyError:
            continue
        for qargs, p in items:
            if qargs is None or p is None:
                continue
            if name.startswith("measure"):
                if len(qargs) == 1 and name == "measure":
                    i = int(qargs[0])
                    if "readout_error" not in q[i] and p.error is not None:
                        q[i]["readout_error"] = p.error
                        qf.setdefault("readout_error", _f("readout_error", "Readout assignment error", "error", "lower"))
                    if "readout_length_ns" not in q[i] and p.duration:
                        q[i]["readout_length_ns"] = p.duration * 1e9
                        qf.setdefault("readout_length_ns", _f("readout_length_ns", "Readout length (ns)", "ns", "lower"))
                continue
            if len(qargs) == 1:
                i = int(qargs[0])
                if p.error is not None:
                    fid = f"{name}_error"
                    q[i][fid] = p.error
                    qf.setdefault(fid, _f(fid, _gate_label(name), "error", "lower"))
                if p.duration and name in ("sx", "x") and i not in gate_len_1q:
                    gate_len_1q[i] = p.duration * 1e9
            elif len(qargs) == 2:
                a, b = sorted(int(x) for x in qargs)
                d = c.setdefault((a, b), {})
                if p.error is not None:
                    fid = f"{name}_error"
                    d[fid] = statistics.fmean([d[fid], p.error]) if d.get(fid) is not None else p.error
                    cf.setdefault(fid, _f(fid, _gate_label(name), "error", "lower"))
                if p.duration:
                    d["gate_length_ns"] = p.duration * 1e9
                    cf.setdefault("gate_length_ns", _f("gate_length_ns", "Gate length (ns)", "ns", "lower"))
    for i, v in gate_len_1q.items():
        q[i]["single_qubit_gate_length_ns"] = v
        qf.setdefault("single_qubit_gate_length_ns", _f("single_qubit_gate_length_ns", "Single-qubit gate length (ns)", "ns", "lower"))
    return q, c, qf, cf, []


def _fid_name(f) -> Optional[str]:
    t = getattr(getattr(f, "fidelityType", None), "name", None)
    return getattr(t, "value", t)


def _braket_fields(resource, n: int):
    """Braket: the cross-vendor standardized calibration. Vendor qubit ids (IQM counts from 1,
    Rigetti has gaps) map to the Target's 0-based indices in sorted order."""
    std = resource.raw_calibration
    q: dict[int, dict[str, Optional[float]]] = {i: {} for i in range(n)}
    c: dict[tuple[int, int], dict[str, Optional[float]]] = {}
    qf: dict[str, CalibrationField] = {}
    cf: dict[str, CalibrationField] = {}
    device: list[DeviceValue] = []
    if std is None:
        return q, c, qf, cf, device
    one = getattr(std, "oneQubitProperties", None) or {}
    two = getattr(std, "twoQubitProperties", None) or {}
    ids = sorted(one, key=lambda k: int(k))
    index = {int(k): i for i, k in enumerate(ids) if i < n}
    for k in ids:
        i = index.get(int(k))
        if i is None:
            continue
        p = one[k]
        for attr, fid, label in [("T1", "t1_us", "T1 (µs)"), ("T2", "t2_us", "T2 (µs)")]:
            v = _num(getattr(getattr(p, attr, None), "value", None))
            if v is not None:
                q[i][fid] = v * 1e6
                qf.setdefault(fid, _f(fid, label, "us", "higher"))
        for f in getattr(p, "oneQubitFidelity", None) or []:
            name, v = _fid_name(f), _num(getattr(f, "fidelity", None))
            if v is None or name is None:
                continue
            if name == "READOUT":
                fid, label, val = "readout_error", "Readout assignment error", 1 - v
            elif name == "READOUT_ERROR_0_TO_1":
                fid, label, val = "readout_error_0_to_1", "Readout error 0→1", v
            elif name == "READOUT_ERROR_1_TO_0":
                fid, label, val = "readout_error_1_to_0", "Readout error 1→0", v
            elif name == "SIMULTANEOUS_RANDOMIZED_BENCHMARKING":
                fid, label, val = "error_1q_simultaneous_rb", "1q error (simultaneous RB)", 1 - v
            elif name == "RANDOMIZED_BENCHMARKING":
                fid, label, val = "error_1q_rb", "1q error (RB)", 1 - v
            else:
                continue
            q[i][fid] = val
            qf.setdefault(fid, _f(fid, label, "error", "lower"))
    for key, props in two.items():
        try:
            a, b = (index.get(int(x)) for x in key.split("-"))
        except ValueError:
            continue
        if a is None or b is None:
            continue
        a, b = sorted((a, b))
        d = c.setdefault((a, b), {})
        for f in getattr(props, "twoQubitGateFidelity", None) or []:
            v = _num(getattr(f, "fidelity", None))
            gate = str(getattr(f, "gateName", "") or "2q")
            if v is None:
                continue
            fid = "two_qubit_clifford_error" if gate.lower().startswith("two_qubit_clifford") else f"{gate.lower()}_error"
            label = "2q Clifford error" if fid == "two_qubit_clifford_error" else f"{gate.upper()} error"
            d[fid] = 1 - v
            cf.setdefault(fid, _f(fid, label, "error", "lower"))
    # Device-wide figures, for vendors with no per-qubit data.
    nat = getattr(resource, "native_calibration", None)
    def dev(fid, label, unit, better, v):
        v = _num(v)
        if v is not None:
            device.append(DeviceValue(field=_f(fid, label, unit, better), value=v))
    fid_map = getattr(nat, "fidelity", None)
    if isinstance(fid_map, dict):  # IonQ
        dev("error_1q", "1q error", "error", "lower", None if (fid_map.get("1Q") or {}).get("mean") is None else 1 - fid_map["1Q"]["mean"])
        dev("error_2q", "2q error", "error", "lower", None if (fid_map.get("2Q") or {}).get("mean") is None else 1 - fid_map["2Q"]["mean"])
        dev("spam_error", "SPAM error", "error", "lower", None if (fid_map.get("spam") or {}).get("mean") is None else 1 - fid_map["spam"]["mean"])
        timing = getattr(nat, "timing", None) or {}
        for k, fid, label in [("T1", "t1_s", "T1 (s)"), ("T2", "t2_s", "T2 (s)"), ("1Q", "gate_time_1q_us", "1q gate time (µs)"), ("2Q", "gate_time_2q_us", "2q gate time (µs)"), ("readout", "readout_time_us", "Readout time (µs)"), ("reset", "reset_time_us", "Reset time (µs)")]:
            v = _num(timing.get(k)) if isinstance(timing, dict) else None
            if v is not None:
                dev(fid, label, "s" if fid.endswith("_s") else "us", "higher" if fid.startswith("t") and fid.endswith("_s") else "lower", v if fid.endswith("_s") else v * 1e6)
    else:  # AQT and others: the standardized flat fields
        for attr, fid, label in [("T1", "t1_s", "T1 (s)"), ("T2", "t2_s", "T2 (s)")]:
            dev(fid, label, "s", "higher", getattr(getattr(std, attr, None), "value", None))
        two_flat = getattr(std, "twoQubitGateFidelity", None) or []
        if two_flat:
            dev("error_2q", "2q error", "error", "lower", 1 - two_flat[0].fidelity)
        ro_flat = getattr(std, "readoutFidelity", None) or []
        if ro_flat:
            dev("readout_error", "Readout error", "error", "lower", 1 - ro_flat[0].fidelity)
    return q, c, qf, cf, device


def topology(resource) -> Topology:
    target = resource.target
    n = int(resource.num_qubits)
    readout: dict[int, list[float]] = {}
    one_q: dict[int, list[float]] = {}
    two_q: dict[tuple[int, int], list[float]] = {}
    pairs: set[tuple[int, int]] = set()
    for name in target.operation_names:
        if name in _SKIP:
            continue
        is_measure = name.startswith("measure")
        if not is_measure and name.startswith("reset"):
            continue
        try:
            props_by_qargs = target[name]
        except KeyError:
            continue
        for qargs, props in props_by_qargs.items():
            if qargs is None:
                continue
            if len(qargs) == 2:
                a, b = sorted(int(q) for q in qargs)
                pairs.add((a, b))
                if props is not None and props.error is not None and not is_measure:
                    two_q.setdefault((a, b), []).append(props.error)
            elif len(qargs) == 1 and props is not None and props.error is not None:
                q = int(qargs[0])
                (readout if is_measure else one_q).setdefault(q, []).append(props.error)
    edges = sorted(pairs)
    all_to_all = n > 1 and len(edges) == n * (n - 1) // 2
    kind, pos = _layout(resource.candidate_id, n, [] if all_to_all else edges, all_to_all)
    xs = [p[0] for p in pos.values()] or [0.0]
    ys = [p[1] for p in pos.values()] or [0.0]
    try:
        qv, cv, qf, cf, device = (_braket_fields if resource.provider_id == "braket" else _ibm_fields)(resource, n)
    except Exception:  # a malformed calibration document must not take the map down
        qv, cv, qf, cf, device = {i: {} for i in range(n)}, {}, {}, {}, []
    if all_to_all:
        cv, cf = {}, {}
    medians = {fid: _median([v[fid] for v in qv.values() if v.get(fid) is not None]) for fid in qf}
    medians.update({fid: _median([v[fid] for v in cv.values() if v.get(fid) is not None]) for fid in cf})
    return Topology(
        candidate_id=resource.candidate_id,
        num_qubits=n,
        all_to_all=all_to_all,
        layout=kind,
        width=max(xs),
        height=max(ys),
        processor=getattr(resource, "processor", None),
        qubit_fields=list(qf.values()),
        coupler_fields=list(cf.values()),
        medians=medians,
        device=device,
        qubits=[
            TopologyQubit(
                index=i,
                x=pos.get(i, (0.0, 0.0))[0],
                y=pos.get(i, (0.0, 0.0))[1],
                readout_error=_median(readout.get(i, [])),
                error_1q=_median(one_q.get(i, [])),
                values=qv.get(i, {}),
            )
            for i in range(n)
        ],
        couplers=[] if all_to_all else [TopologyCoupler(a=a, b=b, error_2q=(statistics.fmean(two_q[(a, b)]) if (a, b) in two_q else None), values=cv.get((a, b), {})) for a, b in edges],
    )
