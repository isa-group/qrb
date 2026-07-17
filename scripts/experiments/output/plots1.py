"""
Grouped boxplot for experiment1_ingestion.csv, styled for Springer LNCS papers.

X-axis  : catalog_size  (2, 4, 6, 8, 10, 12)          -> "type"
Hue     : provider_mix  (mixed, ibm, braket)           -> "group"
Boxes   : distribution of ingestion_ms over the 10 repetitions

Note: ibm and braket only have runs for catalog_size 2/4/6 in this file;
those boxes are simply left out at catalog_size 8/10/12 rather than faked.
ingestion_ms is plotted on a log scale because ibm (~800-1400 ms) and
mixed/braket (~5000-9600 ms) differ by close to an order of magnitude.
"""

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

df = pd.read_csv("experiment1_ingestion.csv")

types = sorted(df["catalog_size"].unique())  # [2, 4, 6, 8, 10, 12]
groups = ["mixed", "ibm", "braket"]  # fixed, meaningful order

df["ingestion_s"] = df["ingestion_ms"] / 1000.0  # convert to seconds

# data[catalog_size][provider_mix] -> list of ingestion_s (None if absent)
data = {
    t: {
        g: df.loc[(df["catalog_size"] == t) & (df["provider_mix"] == g), "ingestion_s"].tolist()
        for g in groups
    }
    for t in types
}

plt.rcParams["font.family"] = "serif"
plt.rcParams["font.serif"] = ["Liberation Serif", "Times New Roman", "Times"]
plt.rcParams["mathtext.fontset"] = "stix"
plt.rcParams["font.size"] = 8
plt.rcParams["axes.titlesize"] = 9
plt.rcParams["axes.labelsize"] = 8
plt.rcParams["xtick.labelsize"] = 7.5
plt.rcParams["ytick.labelsize"] = 7.5
plt.rcParams["legend.fontsize"] = 7.5

CM_TO_IN = 1 / 2.54
fig_width = 12.2 * CM_TO_IN  # LNCS text width
fig_height = 7.5 * CM_TO_IN

group_colors = {"mixed": "#55A868", "ibm": "#4C72B0", "braket": "#DD8452"}
group_hatches = {"mixed": "", "ibm": "//", "braket": "xx"}

fig, ax = plt.subplots(figsize=(fig_width, fig_height), dpi=300)
fig.patch.set_facecolor("white")


n_groups = len(groups)
box_width = 0.22
gap = 0.03
group_span = n_groups * box_width + (n_groups - 1) * gap
type_positions = np.arange(len(types)) * (group_span + 0.55)

# box_positions[group][type] = x position (only set when data exists)
box_positions = {g: {} for g in groups}
for ti, t in enumerate(types):
    present = [g for g in groups if data[t][g]]  # preserve group order
    n_present = len(present)
    for i, g in enumerate(present):
        offset = (i - (n_present - 1) / 2) * (box_width + gap)
        box_positions[g][t] = type_positions[ti] + offset

legend_handles = []
for group in groups:
    color = group_colors[group]
    hatch = group_hatches[group]

    positions, values = [], []
    for t in types:
        if t in box_positions[group]:
            positions.append(box_positions[group][t])
            values.append(data[t][group])

    if not values:
        continue

    bp = ax.boxplot(
        values,
        positions=positions,
        widths=box_width,
        patch_artist=True,
        showmeans=True,
        meanprops=dict(
            marker="D", markerfacecolor="white", markeredgecolor="black", markersize=3.5
        ),
        medianprops=dict(color="black", linewidth=1.1),
        whiskerprops=dict(color="#333333", linewidth=0.8),
        capprops=dict(color="#333333", linewidth=0.8),
        flierprops=dict(
            marker="o", markerfacecolor="red", markeredgecolor="none", markersize=3, alpha=0.7
        ),
    )
    for patch in bp["boxes"]:
        patch.set_facecolor(color)
        patch.set_alpha(0.65)
        patch.set_edgecolor("black")
        patch.set_linewidth(0.7)
        patch.set_hatch(hatch)

    legend_handles.append(
        plt.Rectangle(
            (0, 0),
            1,
            1,
            facecolor=color,
            alpha=0.65,
            edgecolor="black",
            hatch=hatch,
            linewidth=0.7,
            label=group,
        )
    )

ax.set_xticks(type_positions)
ax.set_xticklabels([str(t) for t in types])
ax.set_ylabel("Ingestion Time (s, log scale)")
ax.set_yscale("log")
ax.set_xlabel("Catalog Size (resources)")
ax.grid(axis="y", which="both", linestyle="--", linewidth=0.5, alpha=0.4)
ax.set_axisbelow(True)

for spine in ["top", "right"]:
    ax.spines[spine].set_visible(False)
for spine in ["left", "bottom"]:
    ax.spines[spine].set_linewidth(0.7)
ax.tick_params(width=0.7)

ax.legend(
    handles=legend_handles,
    title="Provider mix",
    loc="upper left",
    bbox_to_anchor=(1.01, 1),
    frameon=False,
    borderaxespad=0,
)

plt.tight_layout()
plt.savefig("experiment1_ingestion_boxplot.pdf", bbox_inches="tight")
plt.savefig("experiment1_ingestion_boxplot.png", dpi=300, bbox_inches="tight")
print("Saved experiment1_ingestion_boxplot.pdf and experiment1_ingestion_boxplot.png")
