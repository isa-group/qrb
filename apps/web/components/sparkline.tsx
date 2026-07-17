"use client";

import { line as d3Line, curveLinear } from "d3-shape";
import { useMemo } from "react";

/**
 * §20 spec: 1.5px muted line, no axes, no gridlines beyond an optional
 * dashed guide, a single colored dot at the latest value. Hand-rolled SVG
 * (not a charting library) so the "only the newest segment draws in" motion
 * rule in §9 stays a simple path-length trick instead of a full redraw.
 */
export function Sparkline({
  values,
  width = 160,
  height = 40,
  className,
}: {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  const { path, lastPoint } = useMemo(() => {
    if (values.length < 2) return { path: "", lastPoint: null };

    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const stepX = width / (values.length - 1);
    const points: [number, number][] = values.map((v, i) => [
      i * stepX,
      height - ((v - min) / span) * (height - 6) - 3,
    ]);

    const generator = d3Line()
      .curve(curveLinear)
      .x((d) => d[0])
      .y((d) => d[1]);

    return {
      path: generator(points) ?? "",
      lastPoint: points[points.length - 1],
    };
  }, [values, width, height]);

  if (!path || !lastPoint) {
    return (
      <div
        className={className}
        style={{ width, height }}
        aria-hidden
      />
    );
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={className}
      role="img"
      aria-label="Recent queue depth trend"
    >
      <path
        d={path}
        fill="none"
        stroke="var(--color-ink-tertiary)"
        strokeWidth={1.5}
      />
      <circle
        cx={lastPoint[0]}
        cy={lastPoint[1]}
        r={4}
        fill="var(--color-primary)"
      />
    </svg>
  );
}
