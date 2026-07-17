"""QRB CLI: circuit + declared preferences -> optimal quantum resource
binding, via OpenBinding. Thin wrapper over qrb.select() and friends.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

import typer
from dotenv import load_dotenv
from openbinding import ConstraintOp, OpenBindingClient

from qrb import (
    ConstraintSpec,
    PhaseTimings,
    Preset,
    build_selection_instance,
    load_qasm3,
    resolve_preferences,
    save_user_preset,
    select as qrb_select,
)
from qrb.catalog import fetch_catalog
from qrb.presets import all_presets, resolve_preset
from qrb.snapshot import save_snapshot

load_dotenv()

app = typer.Typer(name="qrb", help="Quantum resource selection via OpenBinding.")
preset_app = typer.Typer(help="Manage preference presets.")
app.add_typer(preset_app, name="preset")

_CONSTRAINT_OPS = {"le": ConstraintOp.LE, "ge": ConstraintOp.GE, "eq": ConstraintOp.EQ, "lt": ConstraintOp.LT, "gt": ConstraintOp.GT}


def _parse_weights(value: Optional[str]) -> Optional[dict[str, float]]:
    if not value:
        return None
    weights = {}
    for pair in value.split(","):
        key, _, raw_value = pair.partition("=")
        weights[key.strip()] = float(raw_value)
    return weights


def _parse_constraints(value: Optional[str]) -> Optional[list[ConstraintSpec]]:
    if not value:
        return None
    constraints = []
    for triple in value.split(","):
        feature, _, rest = triple.partition(":")
        op_code, _, raw_value = rest.partition(":")
        op_code = op_code.strip().lower()
        if op_code not in _CONSTRAINT_OPS:
            raise typer.BadParameter(
                f"Unknown constraint operator '{op_code}' — expected one of {sorted(_CONSTRAINT_OPS)}"
            )
        constraints.append(
            ConstraintSpec(feature.strip(), _CONSTRAINT_OPS[op_code], float(raw_value))
        )
    return constraints


def _resolve_preferences(
    *,
    preset: Optional[str],
    weight: Optional[str],
    constraint: Optional[str],
    require_provider: Optional[str],
    pareto: bool,
):
    return resolve_preferences(
        preset=preset,
        weights=_parse_weights(weight),
        constraints=_parse_constraints(constraint),
        require_provider=require_provider,
        pareto=pareto,
    )


PresetOption = typer.Option(None, "--preset", help="Named preference profile.")
WeightOption = typer.Option(
    None, "--weight", help="e.g. expected_fidelity=0.5,cost=0.3,queue=0.2"
)
ConstraintOption = typer.Option(
    None,
    "--constraint",
    help="e.g. cost:le:0.5,expected_fidelity:ge:0.9,operational:eq:1 (ops: le/ge/eq/lt/gt)",
)
RequireProviderOption = typer.Option(None, "--require-provider", help="ibm | braket")
ParetoOption = typer.Option(False, "--pareto", help="MANY objective instead of MONO.")
LiveOption = typer.Option(True, "--live/--snapshot", help="Fetch the live catalog or a recorded snapshot.")
SnapshotPathOption = typer.Option(None, "--snapshot-path")
ShotsOption = typer.Option(1024, "--shots")
ProviderFilterOption = typer.Option(None, "--provider", help="Restrict to ibm and/or braket.")
TimingsOption = typer.Option(
    False, "--timings", help="Print a phase timing breakdown to stderr (for benchmarking)."
)


def _print_timings(timings: PhaseTimings) -> None:
    inst = timings.instance
    typer.echo("--- timings ---", err=True)
    typer.echo(
        f"catalog_ms: {timings.catalog_ms:.1f} (cache_hit={timings.catalog_cache_hit})", err=True
    )
    typer.echo(f"preprocessing_ms: {inst.preprocessing_ms:.1f}", err=True)
    typer.echo(f"transpile_ms: {inst.transpile_ms:.1f} (summed across resources)", err=True)
    typer.echo(f"features_ms: {inst.features_ms:.1f} (summed across resources)", err=True)
    typer.echo(f"build_instance_ms: {inst.build_instance_ms:.1f}", err=True)
    typer.echo(f"total_ms: {timings.total_ms:.1f}", err=True)
    typer.echo("per_resource:", err=True)
    for candidate_id, phases in inst.per_resource.items():
        typer.echo(
            f"  {candidate_id}: transpile={phases['transpile_ms']:.1f}ms"
            f" features={phases['features_ms']:.1f}ms",
            err=True,
        )
    if inst.infeasible_reasons:
        typer.echo("infeasible_reasons:", err=True)
        for candidate_id, reason in inst.infeasible_reasons.items():
            typer.echo(f"  {candidate_id}: {reason}", err=True)


@app.command("select")
def select_command(
    circuit: Path = typer.Argument(..., help="OpenQASM 3 circuit file."),
    preset: Optional[str] = PresetOption,
    weight: Optional[str] = WeightOption,
    constraint: Optional[str] = ConstraintOption,
    require_provider: Optional[str] = RequireProviderOption,
    pareto: bool = ParetoOption,
    engine: Optional[str] = typer.Option(None, "--engine"),
    live: bool = LiveOption,
    snapshot_path: Optional[Path] = SnapshotPathOption,
    shots: int = ShotsOption,
    provider: Optional[list[str]] = ProviderFilterOption,
    output: Optional[Path] = typer.Option(None, "-o", "--output"),
    timings: bool = TimingsOption,
) -> None:
    """Build the BIM instance from CIRCUIT + preferences and solve it."""
    circuit_obj = load_qasm3(circuit)
    preferences = _resolve_preferences(
        preset=preset,
        weight=weight,
        constraint=constraint,
        require_provider=require_provider,
        pareto=pareto,
    )
    response, phase_timings = qrb_select(
        circuit_obj,
        preferences,
        shots=shots,
        live=live,
        snapshot_path=snapshot_path,
        providers=provider,
        engine_id=engine,
    )
    if timings:
        _print_timings(phase_timings)
    if output is not None:
        output.write_text(response.model_dump_json(indent=2))
        typer.echo(f"Wrote solve response to {output}")
        return
    typer.echo(f"feasibility: {response.feasibility}")
    for solution in response.solutions:
        typer.echo(f"binding: {solution.binding}")
        typer.echo(f"  objective_value: {solution.objective_value}")
        typer.echo(f"  features: {solution.aggregated_features}")


@app.command("instance")
def instance_command(
    circuit: Path = typer.Argument(..., help="OpenQASM 3 circuit file."),
    preset: Optional[str] = PresetOption,
    weight: Optional[str] = WeightOption,
    constraint: Optional[str] = ConstraintOption,
    require_provider: Optional[str] = RequireProviderOption,
    pareto: bool = ParetoOption,
    live: bool = LiveOption,
    snapshot_path: Optional[Path] = SnapshotPathOption,
    shots: int = ShotsOption,
    provider: Optional[list[str]] = ProviderFilterOption,
    output: Optional[Path] = typer.Option(None, "-o", "--output"),
    timings: bool = TimingsOption,
) -> None:
    """Emit the BIM instance without solving — for inspection or paper artifacts."""
    circuit_obj = load_qasm3(circuit)
    preferences = _resolve_preferences(
        preset=preset,
        weight=weight,
        constraint=constraint,
        require_provider=require_provider,
        pareto=pareto,
    )
    inst, phase_timings = build_selection_instance(
        circuit_obj,
        preferences,
        shots=shots,
        live=live,
        snapshot_path=snapshot_path,
        providers=provider,
    )
    if timings:
        _print_timings(phase_timings)
    text = inst.model_dump_json(indent=2, by_alias=True)
    if output is not None:
        output.write_text(text)
        typer.echo(f"Wrote instance to {output}")
    else:
        typer.echo(text)


@app.command("catalog")
def catalog_command(
    live: bool = LiveOption,
    snapshot_path: Optional[Path] = SnapshotPathOption,
    provider: Optional[list[str]] = ProviderFilterOption,
    refresh: Optional[Path] = typer.Option(
        None, "--refresh", help="Fetch the live catalog and write a snapshot to PATH."
    ),
) -> None:
    """Fetch and display the Resource catalog, or refresh a snapshot file."""
    if refresh is not None:
        resources = fetch_catalog(live=True, providers=provider)
        save_snapshot(resources, refresh)
        typer.echo(f"Wrote {len(resources)} resources to {refresh}")
        return

    resources = fetch_catalog(live=live, snapshot_path=snapshot_path, providers=provider)
    for resource in resources:
        typer.echo(
            f"{resource.candidate_id}\t{resource.name}\t{resource.num_qubits}q"
            f"\tqueue={resource.queue_length}"
        )


@app.command("engines")
def engines_command() -> None:
    """List OpenBinding solver engines and their capabilities."""
    with OpenBindingClient() as client:
        for engine in client.engines():
            status = "active" if engine.active else "inactive"
            typer.echo(f"{engine.id}\t{engine.capabilities.type}\t{status}")


@preset_app.command("list")
def preset_list_command() -> None:
    for name, preset in all_presets().items():
        typer.echo(f"{name}\t{preset.weights}")


@preset_app.command("show")
def preset_show_command(name: str) -> None:
    preset = resolve_preset(name)
    typer.echo(preset)


@preset_app.command("save")
def preset_save_command(
    name: str,
    weight: str = typer.Option(..., "--weight"),
    constraint: Optional[str] = ConstraintOption,
) -> None:
    preset = Preset(
        name=name,
        weights=_parse_weights(weight) or {},
        constraints=_parse_constraints(constraint) or [],
    )
    save_user_preset(preset)
    typer.echo(f"Saved preset '{name}'")


if __name__ == "__main__":
    app()
