"use client";

import { useEffect, useRef, useState } from "react";

import styles from "./landing.module.css";

/** The poster is this moment of the scene; the live animation starts from it so the handover is seamless. */
const POSTER_TIME = 9;

/**
 * The live ASCII cryostat. The poster still shows first (and stays when WebGL2 is missing);
 * the scene module loads after the page is interactive and fades in once its first frame is drawn.
 */
export function HeroScene() {
  const box = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let dispose: (() => void) | undefined;
    let cancelled = false;
    const onReady = () => setReady(true);
    el.addEventListener("scene-ready", onReady);

    const start = async () => {
      const reduced = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      const wide = window.matchMedia("(min-width: 1025px)");
      try {
        const { mount } = await import("@/scenes/qpu-hero/main.js");
        if (cancelled) return;
        dispose = mount(el, {
          focusX: wide.matches ? 0.7 : 0.5,
          frozenAt: reduced ? POSTER_TIME : null,
          startAt: POSTER_TIME,
        }).dispose;
      } catch {
        // No WebGL2: the poster stays.
      }
    };
    const idle =
      window.requestIdleCallback ??
      ((cb: () => void) => window.setTimeout(cb, 200));
    idle(() => void start());

    return () => {
      cancelled = true;
      el.removeEventListener("scene-ready", onReady);
      dispose?.();
    };
  }, []);

  return (
    <div className={styles.scene} ref={box} data-ready={ready}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className={styles.poster}
        src="/scenes/qpu-hero/poster.webp"
        alt=""
        width={900}
        height={900}
        fetchPriority="high"
      />
    </div>
  );
}
