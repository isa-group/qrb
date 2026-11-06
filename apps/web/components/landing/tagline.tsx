"use client";

import { useEffect, useRef } from "react";

import styles from "./landing.module.css";

/** Large statement whose words brighten one at a time as they cross a line 60% down the viewport. */
export function Tagline({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const words = Array.from(el.querySelectorAll<HTMLElement>("[data-word]"));
    words.forEach((w) => (w.dataset.lit = "false"));
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => ((e.target as HTMLElement).dataset.lit = String(e.isIntersecting || e.boundingClientRect.top < 0))),
      { rootMargin: "0px 0px -40% 0px", threshold: 1 },
    );
    words.forEach((w) => io.observe(w));
    return () => io.disconnect();
  }, []);

  return (
    <p ref={ref} className={`${styles.tagline} heading-3`}>
      {lines.map((line, li) => (
        <span key={li} className={styles.taglineLine}>
          {line.split(" ").map((word, wi) => (
            <span key={wi} data-word>
              {word}{" "}
            </span>
          ))}
        </span>
      ))}
    </p>
  );
}
