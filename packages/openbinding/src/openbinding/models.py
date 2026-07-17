"""Pydantic models for the OpenBinding wire format (BIM instance + gateway I/O).

Mirrors https://openbinding.score.us.es/api/openapi.json. This module is
domain-agnostic: it knows nothing about quantum resources, only about the
Binding Instance Model tuple I=(T,P,C,F,G,Λ,Δ,O) and the gateway's request/
response envelopes.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field, model_validator

Identifier = Annotated[str, Field(pattern=r"^[A-Za-z0-9_.-]+$", min_length=1)]


class Direction(str, Enum):
    MAXIMIZE = "MAXIMIZE"
    MINIMIZE = "MINIMIZE"


class Scale(str, Enum):
    RATIO = "RATIO"
    INTERVAL = "INTERVAL"
    ORDINAL = "ORDINAL"


class ConstraintOp(str, Enum):
    LE = "<="
    GE = ">="
    EQ = "=="
    LT = "<"
    GT = ">"
    IN_RANGE = "IN_RANGE"


class DependencyType(str, Enum):
    SAME_PROVIDER = "SAME_PROVIDER"
    DIFFERENT_PROVIDER = "DIFFERENT_PROVIDER"


class ComposeFnName(str, Enum):
    SUM = "SUM"
    PRODUCT = "PRODUCT"
    MAX = "MAX"
    MIN = "MIN"
    SCALED_SUM = "SCALED_SUM"
    SCALED_PRODUCT = "SCALED_PRODUCT"
    SCALED_MIN = "SCALED_MIN"
    SCALED_MAX = "SCALED_MAX"
    MEAN = "MEAN"


class Feasibility(str, Enum):
    FEASIBLE = "FEASIBLE"
    INFEASIBLE = "INFEASIBLE"
    UNKNOWN = "UNKNOWN"


class JobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class NumericRange(BaseModel):
    min: float
    max: float


# --- BIM: T, P ---


class ProviderRef(BaseModel):
    id: Identifier
    name: str = Field(min_length=1)
    description: str | None = None


class TaskRef(BaseModel):
    id: Identifier
    name: str = Field(min_length=1)
    description: str | None = None


# --- BIM: C ---


class Candidate(BaseModel):
    id: Identifier
    task_id: Identifier
    provider_id: Identifier
    name: str = Field(min_length=1)
    features: dict[str, float] = Field(min_length=1)
    description: str | None = None


# --- BIM: F ---


class Feature(BaseModel):
    id: Identifier
    name: str = Field(min_length=1)
    direction: Direction
    unit: str = Field(min_length=1)
    scale: Scale
    valid_range: NumericRange
    description: str | None = None


# --- BIM: G (workflow composition tree) ---


class TaskNode(BaseModel):
    id: Identifier
    kind: Literal["TASK"] = "TASK"
    task_id: Identifier
    description: str | None = None


class SeqNode(BaseModel):
    id: Identifier
    kind: Literal["SEQ"] = "SEQ"
    children: list["Node"] = Field(min_length=2)
    description: str | None = None


class AndNode(BaseModel):
    id: Identifier
    kind: Literal["AND"] = "AND"
    children: list["Node"] = Field(min_length=2)
    description: str | None = None


class XorBranch(BaseModel):
    p: float = Field(gt=0.0, le=1.0)
    child: "Node"


class XorNode(BaseModel):
    id: Identifier
    kind: Literal["XOR"] = "XOR"
    branches: list[XorBranch] = Field(min_length=2)
    description: str | None = None


class LoopBounds(BaseModel):
    min: int | None = Field(default=None, ge=0)
    max: int | None = Field(default=None, ge=0)


class LoopNode(BaseModel):
    id: Identifier
    kind: Literal["LOOP"] = "LOOP"
    body: "Node"
    expected_iterations: float | None = Field(default=None, ge=0.0)
    bounds: LoopBounds | None = None
    description: str | None = None


class ElementNode(BaseModel):
    id: Identifier
    kind: Literal["ELEMENT"] = "ELEMENT"
    description: str | None = None


Node = Annotated[
    Union[TaskNode, SeqNode, AndNode, XorNode, LoopNode, ElementNode],
    Field(discriminator="kind"),
]
SeqNode.model_rebuild()
AndNode.model_rebuild()
XorBranch.model_rebuild()
LoopNode.model_rebuild()


class StructuredTree(BaseModel):
    type: Literal["STRUCTURED"] = "STRUCTURED"
    root: Node


# --- BIM: Λ (aggregation policies) ---


class ComposeFn(BaseModel):
    fn: ComposeFnName


class Compose(BaseModel):
    seq: ComposeFn | None = None
    and_: ComposeFn | None = Field(default=None, alias="and")
    xor: ComposeFn | None = None
    loop: ComposeFn | None = None

    model_config = {"populate_by_name": True}

    @model_validator(mode="after")
    def _exactly_one(self) -> "Compose":
        set_fields = [f for f in (self.seq, self.and_, self.xor, self.loop) if f is not None]
        if len(set_fields) != 1:
            raise ValueError("compose must set exactly one of seq/and/xor/loop")
        return self


class AggregationPolicy(BaseModel):
    neutral: float
    compose: Compose


# --- BIM: Δ (constraints) ---


class AttributeBoundConstraint(BaseModel):
    id: Identifier
    kind: Literal["ATTRIBUTE_BOUND"] = "ATTRIBUTE_BOUND"
    scope: Literal["GLOBAL", "LOCAL"]
    tasks: list[Identifier] | None = None
    candidates: list[Identifier] | None = None
    attribute_id: Identifier
    op: ConstraintOp
    value: float | NumericRange
    hard: bool = True
    description: str | None = None


class DependencyConstraint(BaseModel):
    id: Identifier
    kind: Literal["DEPENDENCY"] = "DEPENDENCY"
    type: DependencyType
    tasks: list[Identifier] = Field(min_length=2)
    hard: bool = True
    description: str | None = None


Constraint = Annotated[
    Union[AttributeBoundConstraint, DependencyConstraint], Field(discriminator="kind")
]


# --- BIM: O (objective) ---


class MonoObjective(BaseModel):
    type: Literal["MONO"] = "MONO"
    targets: list[Identifier] = Field(min_length=1)
    weights: dict[str, float] = Field(min_length=1)
    weights_sum_to_one: bool = True


class MultiObjective(BaseModel):
    type: Literal["MULTI"] = "MULTI"
    targets: list[Identifier] = Field(min_length=2, max_length=3)
    weights: dict[str, float] = Field(min_length=1)
    weights_sum_to_one: bool = True


class ManyObjective(BaseModel):
    type: Literal["MANY"] = "MANY"
    targets: list[Identifier] = Field(min_length=3)
    weights: dict[str, float] = Field(min_length=1)
    weights_sum_to_one: bool = True


Objective = Annotated[
    Union[MonoObjective, MultiObjective, ManyObjective], Field(discriminator="type")
]


# --- BIM instance ---


class InstanceMetadata(BaseModel):
    id: Identifier
    name: str = Field(min_length=1)
    version: str = Field(min_length=1)
    created_at: datetime
    description: str | None = None

    model_config = {"extra": "allow"}


class Instance(BaseModel):
    """The BIM tuple I=(T,P,C,F,G,Λ,Δ,O) — 'Compact QoS-Aware Service Composition'."""

    metadata: InstanceMetadata
    providers: list[ProviderRef] = Field(min_length=1)
    tasks: list[TaskRef] = Field(min_length=1)
    candidates: list[Candidate] = Field(min_length=1)
    features: list[Feature] = Field(min_length=1)
    composition: StructuredTree
    aggregation_policies: dict[str, AggregationPolicy] = Field(min_length=1)
    constraints: list[Constraint] = Field(default_factory=list)
    objective: Objective


# --- Gateway request/response envelopes ---


class SolveRequest(BaseModel):
    engine_id: str
    instance: Instance
    options: dict | None = None
    verbose: bool = False


class ValidationViolation(BaseModel):
    constraint_id: str | None = None
    message: str
    path: str | None = None
    code: str
    stage: str | None = None
    penalty: float | None = None
    description: str | None = None


class Solution(BaseModel):
    objective_value: float | None = None
    binding: dict[str, str]
    """Map of Task ID to Candidate ID."""
    aggregated_features: dict[str, float] = Field(default_factory=dict)
    violations: list[ValidationViolation] = Field(default_factory=list)


class Provenance(BaseModel):
    engine_id: str
    execution_time_ms: float | None = None
    metadata: dict | None = None

    model_config = {"extra": "allow"}


class SolveResponse(BaseModel):
    feasibility: Feasibility = Feasibility.UNKNOWN
    solutions: list[Solution]
    provenance: Provenance
    diagnostics: dict | None = None


class AnalyzeWarning(BaseModel):
    code: str
    message: str
    details: dict | None = None


class BindingSpaceSummary(BaseModel):
    cardinality: str
    log10_cardinality: float
    per_task_counts: dict[str, int]
    empty_tasks: list[str] = Field(default_factory=list)


class AnalyzeResponse(BaseModel):
    status: str = "validated"
    binding_space: BindingSpaceSummary | None = None
    diagnostics: dict | None = None
    warnings: list[AnalyzeWarning] | None = None
    provenance: Provenance | None = None
    error: str | None = None


class BindingSpaceRequest(BaseModel):
    engine_id: str
    instance: Instance
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=100, ge=1, le=1000)


class BindingSpacePage(BaseModel):
    total_combinations: str
    offset: int
    limit: int
    bindings: list[dict[str, str]]


class JobResponse(BaseModel):
    job_id: str
    status: JobStatus
    result: SolveResponse | None = None
    error: str | None = None


class EngineCapabilities(BaseModel):
    qos_features_supported: list[str]
    composition_nodes_supported: list[str]
    objective_types_supported: list[str]
    constraints_supported: list[str]
    type: str
    schema_version: str


class EngineInfo(BaseModel):
    id: str
    capabilities: EngineCapabilities
    active: bool
