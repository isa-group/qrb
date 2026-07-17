"""Experiment 3 ternary figure

Usage:
    python plots3.py \
        --ternary output/experiment3_ternary.csv \
        --outdir figures/

Input is the CSV produced by experiment3_preferences.py.
"""

import argparse
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

# Winner styling. Any candidate found in the CSV but missing here gets a
# fallback style, so a future snapshot with different winners still plots.
NICE = {
    "braket.Cepheus-1-108Q": "Cepheus-1-108Q (Braket)",
    "braket.Forte_1": "Forte 1 (Braket)",
    "ibm.ibm_marrakesh": "Marrakesh (IBM)",
    "ibm.ibm_pittsburgh": "Pittsburgh (IBM)",
    "ibm.ibm_aachen": "Aachen (IBM)",
}
COL = {
    "braket.Cepheus-1-108Q": "#55A868",
    "braket.Forte_1": "#DD8452",
    "ibm.ibm_marrakesh": "#4C72B0",
    "ibm.ibm_pittsburgh": "#8172B3",
    "ibm.ibm_aachen": "#C44E52",
}
MRK = {
    "braket.Cepheus-1-108Q": "^",
    "braket.Forte_1": "s",
    "ibm.ibm_marrakesh": "o",
    "ibm.ibm_pittsburgh": "D",
    "ibm.ibm_aachen": "v",
}
FALLBACK_COLORS = ["#937860", "#DA8BC3", "#8C8C8C", "#CCB974", "#64B5CD"]
FALLBACK_MARKERS = ["P", "X", "*", "h", "p"]

CM = 1 / 2.54


def lncs_style() -> None:
    plt.rcParams["font.family"] = "serif"
    plt.rcParams["font.serif"] = ["Liberation Serif", "Times New Roman", "Times"]
    plt.rcParams["mathtext.fontset"] = "stix"
    plt.rcParams["font.size"] = 10  # Tamaño aumentado para alta legibilidad
    plt.rcParams["legend.fontsize"] = 9


def tern(wc, wf, wq):
    """Barycentric -> cartesian. Corners: cost bottom-left (1,0,0),
    fidelity bottom-right (0,1,0), queue top (0,0,1)."""
    x = wf + 0.5 * wq
    y = (np.sqrt(3) / 2) * wq
    return x, y


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ternary", default="experiment3_ternary.csv")
    ap.add_argument("--outdir", default=".")
    args = ap.parse_args()

    t = pd.read_csv(args.ternary)
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    lncs_style()
    fig, ax = plt.subplots(figsize=(10.0 * CM, 9.5 * CM), dpi=300)
    fig.patch.set_facecolor("white")

    # Triangle frame + light 0.1 gridlines
    frame = np.array([tern(1, 0, 0), tern(0, 1, 0), tern(0, 0, 1), tern(1, 0, 0)])
    ax.plot(frame[:, 0], frame[:, 1], color="black", lw=0.8, zorder=1)
    for f in np.arange(0.1, 1.0, 0.1):
        for a_, b_ in [
            ((f, 1 - f, 0), (f, 0, 1 - f)),
            ((1 - f, f, 0), (0, f, 1 - f)),
            ((1 - f, 0, f), (0, 1 - f, f)),
        ]:
            x1, y1 = tern(*a_)
            x2, y2 = tern(*b_)
            ax.plot([x1, x2], [y1, y2], color="gray", lw=0.3, alpha=0.35, zorder=0)

    # Points, one series per winner (stable order: by frequency desc.)
    winners = t.selected_candidate_id.value_counts().index.tolist()
    fb = 0
    for w in winners:
        if w not in COL:
            COL[w] = FALLBACK_COLORS[fb % len(FALLBACK_COLORS)]
            MRK[w] = FALLBACK_MARKERS[fb % len(FALLBACK_MARKERS)]
            NICE[w] = w
            fb += 1
        sub = t[t.selected_candidate_id == w]
        xs, ys = tern(sub.w_cost.values, sub.w_fidelity.values, sub.w_queue.values)
        ax.scatter(
            xs,
            ys,
            s=26,
            marker=MRK[w],
            color=COL[w],
            edgecolor="black",
            linewidth=0.4,
            label=NICE[w],
            zorder=3,
        )

    # --- ANOTACIONES DE LOS VÉRTICES ---
    ax.annotate(
        "$w_{\\mathrm{cost}}=1$\n(1, 0, 0)",
        xy=tern(1, 0, 0),
        xytext=(-10, -12),
        textcoords="offset points",
        ha="right",
        va="top",
        fontsize=9.5,
    )
    ax.annotate(
        "$w_{\\mathrm{fidelity}}=1$\n(0, 1, 0)",
        xy=tern(0, 1, 0),
        xytext=(10, -12),
        textcoords="offset points",
        ha="left",
        va="top",
        fontsize=9.5,
    )
    ax.annotate(
        "$w_{\\mathrm{queue}}=1$\n(0, 0, 1)",
        xy=tern(0, 0, 1),
        xytext=(0, 8),
        textcoords="offset points",
        ha="center",
        va="bottom",
        fontsize=9.5,
    )

    # --- ANOTACIONES DE LOS PUNTOS MEDIOS PERIMETRALES ---
    puntos_medios = [
        ((0.5, 0.5, 0), "(0.5, 0.5, 0)", (0, -15), "center", "top"),
        ((0, 0.5, 0.5), "(0, 0.5, 0.5)", (10, 4), "left", "center"),
        ((0.5, 0, 0.5), "(0.5, 0, 0.5)", (-10, 4), "right", "center"),
    ]

    for weights, label, offset, ha, va in puntos_medios:
        x, y = tern(*weights)
        ax.plot(x, y, marker="x", color="black", markersize=4, alpha=0.5, zorder=2)
        ax.annotate(
            label,
            xy=(x, y),
            xytext=offset,
            textcoords="offset points",
            ha=ha,
            va=va,
            fontsize=8,
            color="#222222",
        )

    # Límites ajustados sin el aire extra que requerían las etiquetas del centro
    ax.set_xlim(-0.28, 1.28)
    ax.set_ylim(-0.22, 1.12)
    ax.set_aspect("equal")
    ax.axis("off")

    # Leyenda en el espacio horizontal derecho
    ax.legend(
        loc="upper left",
        bbox_to_anchor=(0.78, 1.05),
        frameon=False,
        handletextpad=0.3,
        borderaxespad=0,
        fontsize=8.5,
    )

    plt.tight_layout(pad=0.3)
    for ext in ("pdf", "png"):
        fig.savefig(
            outdir / f"experiment3-ternary.{ext}",
            bbox_inches="tight",
            dpi=300 if ext == "png" else None,
        )
    print(f"wrote {outdir}/experiment3-ternary.pdf and .png")


if __name__ == "__main__":
    main()
