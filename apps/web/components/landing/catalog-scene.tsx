"use client";

import { ArrowRight } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

import styles from "./landing.module.css";

/** One set of preferences and its saved answer on the frozen snapshot (fixtures/select-*.json). */
export type PresetWinner = {
  key: string;
  name: string;
  /** /bind link that repeats these preferences. */
  href: string;
  weights: { label: string; share: number }[];
  candidateId: string;
  qpu: string;
  provider: "ibm" | "braket" | string;
};

const PROVIDERS: Record<string, string> = {
  ibm: "IBM Quantum",
  braket: "Amazon Braket",
};
const FROZEN_AT = 15; // the camera's mid-sweep moment, used for the poster and under reduced motion

type Handle = {
  setSelected(id: string | null): boolean;

  dispose(): void;
};

/**
 * The catalog floor beside the tagline: all 12 snapshot QPUs, with the winner of the chosen preset lit.
 * Winners are the API's saved answers, so the page shows what the solver returned, never a guess.
 * The scene loads when the section comes near; the poster stands in until then and without WebGL2.
 */
export function CatalogScene({ winners }: { winners: PresetWinner[] }) {
  const [index, setIndex] = useState(0);
  const [ready, setReady] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const handle = useRef<Handle | null>(null);
  const toDevice = useRef<((id: string) => string | null) | null>(null);
  const ids = useId();
  const current = winners[index];
  const latest = useRef(current);
  latest.current = current;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let cancelled = false;
    const onReady = () => setReady(true);
    el.addEventListener("scene-ready", onReady);
    const near = new IntersectionObserver(
      async ([e]) => {
        if (!e.isIntersecting) return;
        near.disconnect();
        try {
          const mod = await import("@/scenes/qpu-catalog/main.js");
          if (cancelled) return;
          toDevice.current = mod.candidateToDevice;
          const reduced = window.matchMedia(
            "(prefers-reduced-motion: reduce)",
          ).matches;
          handle.current = mod.mount(el, {
            select: mod.candidateToDevice(latest.current.candidateId),
            frozenAt: reduced ? FROZEN_AT : null,
          });
        } catch {
          // No WebGL2: the poster stays.
        }
      },
      { rootMargin: "400px 0px" },
    );
    near.observe(el);
    return () => {
      cancelled = true;
      near.disconnect();
      el.removeEventListener("scene-ready", onReady);
      handle.current?.dispose();
      handle.current = null;
    };
  }, [winners]);

  useEffect(() => {
    if (handle.current && toDevice.current)
      handle.current.setSelected(toDevice.current(current.candidateId));
  }, [current]);

  return (
    <div className={styles.catalog}>
      <div className={styles.catalogScene} ref={box} data-ready={ready}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className={styles.catalogPoster}
          src="/scenes/qpu-catalog/poster.webp"
          alt="The 12 QPUs of the frozen catalog snapshot drawn as glyphs on a lab floor, the binding lit in violet."
          width={720}
          height={720}
          loading="lazy"
        />
      </div>

      <div className={styles.catalogPanel}>
        <fieldset className={styles.catalogChoice}>
          <legend className="caption-2 muted">Preferences</legend>
          <div className={styles.segmented}>
            {winners.map((w, i) => (
              <label key={w.key}>
                <input
                  type="radio"
                  name={`${ids}-preset`}
                  checked={i === index}
                  onChange={() => setIndex(i)}
                />
                <span className="body-5">{w.name}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className={styles.catalogResult} aria-live="polite">
          <p className={`${styles.catalogLabel} caption-2`}>Binding</p>
          <p className="heading-5">{current.qpu}</p>
          <p
            className={`${styles.provider} body-6 soft`}
            data-provider={current.provider}
          >
            {PROVIDERS[current.provider] ?? current.provider}
          </p>
          <p className="caption-2 muted">
            {current.weights.map((w) => `${w.label} ${w.share}%`).join(" · ")}
          </p>
        </div>

        <Link href={current.href} className="link body-5">
          Try {current.name} with your circuit{" "}
          <ArrowRight size={16} aria-hidden />
        </Link>
      </div>
    </div>
  );
}
