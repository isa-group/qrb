#!/usr/bin/env python3
"""Experiment 2 scaling figure

Usage:
    python plots2.py \
        --summary output/experiment2_per_run_summary.csv \
        --candidates output/experiment2_per_candidate.csv \
        --outdir figures/
"""

import argparse
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.gridspec as gridspec
import matplotlib.pyplot as plt
import pandas as pd

QUBIT_GRID = [2, 4, 8, 12, 15, 20, 28, 36, 53, 65, 84, 107, 156]
# qubit threshold -> feasible candidates from that size on (Table tab:feasibility)
THRESHOLDS = [(2, 12), (15, 11), (28, 10), (53, 8), (65, 7), (156, 6)]

FAMS = ["ghz", "qaoa", "randomcircuit"]
COL = {"ghz": "#4C72B0", "qaoa": "#DD8452", "randomcircuit": "#55A868"}
LAB = {"ghz": "GHZ", "qaoa": "QAOA", "randomcircuit": "Random"}
MRK = {"ghz": "o", "qaoa": "s", "randomcircuit": "^"}
C_TR, C_FE, C_BOUND = "#C8845C", "#F2DCA8", "#6B3E23"

CM = 1 / 2.54


def lncs_style() -> None:
    plt.rcParams["font.family"] = "serif"
    plt.rcParams["font.serif"] = ["Liberation Serif", "Times New Roman", "Times"]
    plt.rcParams["mathtext.fontset"] = "stix"
    plt.rcParams["font.size"] = 8
    plt.rcParams["axes.titlesize"] = 9
    plt.rcParams["axes.labelsize"] = 8
    plt.rcParams["xtick.labelsize"] = 7.5
    plt.rcParams["ytick.labelsize"] = 7.5
    plt.rcParams["legend.fontsize"] = 7.5


def clean_spines(ax, grid: bool = True) -> None:
    for sp in ["top", "right"]:
        ax.spines[sp].set_visible(False)
    for sp in ["left", "bottom"]:
        ax.spines[sp].set_linewidth(0.7)
    ax.tick_params(width=0.7)
    if grid:
        ax.grid(axis="y", which="both", linestyle="--", linewidth=0.5, alpha=0.4)
        ax.set_axisbelow(True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--summary", default="experiment2_per_run_summary.csv")
    ap.add_argument("--candidates", default="experiment2_per_candidate.csv")
    ap.add_argument("--outdir", default=".")
    args = ap.parse_args()

    s = pd.read_csv(args.summary)
    c = pd.read_csv(args.candidates)
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    lncs_style()
    fig = plt.figure(figsize=(12.2 * CM, 10.2 * CM), dpi=300)
    fig.patch.set_facecolor("white")
    gs = gridspec.GridSpec(2, 3, height_ratios=[1.9, 1], hspace=0.40, wspace=0.10)

    # ---------------- panel (a): absolute scaling ----------------
    ax = fig.add_subplot(gs[0, :])
    for fam in FAMS:
        g = s[s.family == fam].groupby("qubits")["instance_build_ms"]
        med, q1, q3 = g.median() / 1e3, g.quantile(0.25) / 1e3, g.quantile(0.75) / 1e3
        ax.errorbar(
            med.index,
            med.values,
            yerr=[med - q1, q3 - med],
            fmt=MRK[fam] + "-",
            ms=3.2,
            lw=1.0,
            capsize=1.8,
            color=COL[fam],
            label=f"Instance build — {LAB[fam]}",
            markeredgecolor="black",
            markeredgewidth=0.4,
        )
    r = s.groupby("qubits")["resolution_ms"].median() / 1e3
    ax.plot(r.index, r.values, "k--", lw=1.1, label="OpenBinding resolution (all families)")
    for x, _ in THRESHOLDS:
        ax.axvline(x, color="gray", alpha=0.3, lw=0.6, ls=":")
    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_xticks(QUBIT_GRID)
    ax.set_xticklabels(QUBIT_GRID)
    ax.minorticks_off()
    ax.set_xlabel("Circuit size (qubits, log scale)")
    ax.set_ylabel("Instance build time (s, log scale)")
    clean_spines(ax)
    ax.legend(loc="upper left", frameon=False)
    sec = ax.secondary_xaxis("top")
    sec.set_xticks([x for x, _ in THRESHOLDS])
    sec.set_xticklabels([n for _, n in THRESHOLDS])
    sec.set_xlabel("Feasible candidates after threshold", fontsize=7.5)
    sec.tick_params(width=0.7, labelsize=7)
    sec.spines["top"].set_visible(False)
    ax.text(0.985, 0.04, "(a)", transform=ax.transAxes, fontsize=9, fontweight="bold", ha="right")

    # -------- panels (b): per-family composition ---------
    for i, fam in enumerate(FAMS):
        axb = fig.add_subplot(gs[1, i])
        cc = (
            c[(c.feasible == True) & (c.family == fam)]  # noqa: E712
            .groupby(["qubits", "repetition"])[["transpilation_ms", "feature_computation_ms"]]
            .sum()
            .reset_index()
        )
        m = cc.merge(
            s[s.family == fam][["qubits", "repetition", "instance_build_ms"]],
            on=["qubits", "repetition"],
        )
        m["assembly_ms"] = m.instance_build_ms - m.transpilation_ms - m.feature_computation_ms
        agg = m.groupby("qubits")[
            ["transpilation_ms", "feature_computation_ms", "assembly_ms", "instance_build_ms"]
        ].median()
        tr = 100 * agg.transpilation_ms / agg.instance_build_ms

        # two soft fills split by the emphasized boundary line (the data)
        axb.fill_between(agg.index, 0, tr, color=C_TR, alpha=0.9, lw=0)
        axb.fill_between(agg.index, tr, 100, color=C_FE, alpha=0.9, lw=0)
        axb.plot(
            agg.index,
            tr,
            color=C_BOUND,
            lw=1.2,
            marker="o",
            ms=2.2,
            markerfacecolor="white",
            markeredgewidth=0.6,
            markeredgecolor=C_BOUND,
            clip_on=False,
            zorder=5,
        )

        axb.axhline(56, color="black", lw=0.7, ls=":", zorder=4)
        if i == 2:
            axb.annotate(
                "56 %",
                xy=(150, 56),
                xytext=(0, 3),
                textcoords="offset points",
                ha="right",
                fontsize=6.5,
            )
        if i == 1:  # direct labels instead of a legend
            axb.text(
                22, 26, "Transpilation", fontsize=7, color="#4A2814", ha="center", style="italic"
            )
            axb.text(
                22,
                84,
                "Feature\ncomputation",
                fontsize=7,
                color="#6B5518",
                ha="center",
                va="center",
                style="italic",
                linespacing=0.95,
            )

        axb.set_xscale("log")
        axb.set_xticks([2, 15, 53, 156])
        axb.set_xticklabels([2, 15, 53, 156])
        axb.minorticks_off()
        axb.set_ylim(0, 100)
        axb.set_xlim(2, 156)
        axb.set_yticks([0, 25, 50, 75, 100])
        axb.set_title(LAB[fam], fontsize=8, pad=2.5)
        if i == 0:
            axb.set_ylabel("Share of build (%)")
        else:
            axb.set_yticklabels([])
        if i == 1:
            axb.set_xlabel("Circuit size (qubits, log scale)")
        for sp in ["top", "right"]:
            axb.spines[sp].set_visible(False)
        for sp in ["left", "bottom"]:
            axb.spines[sp].set_linewidth(0.7)
        axb.tick_params(width=0.7)
        if i == 2:
            axb.text(
                0.95,
                0.06,
                "(b)",
                transform=axb.transAxes,
                fontsize=9,
                fontweight="bold",
                ha="right",
            )

    for ext in ("pdf", "png"):
        fig.savefig(
            outdir / f"experiment2-scaling.{ext}", bbox_inches="tight", dpi=300 if ext == "png" else None
        )
    print(f"wrote {outdir}/experiment2-scaling.pdf and .png")


if __name__ == "__main__":
    main()
