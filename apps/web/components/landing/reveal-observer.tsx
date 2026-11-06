"use client";

import { useEffect } from "react";

/** Marks every [data-reveal] block pending, then reveals each once as it enters the viewport. */
export function RevealObserver() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    const below = els.filter((el) => el.getBoundingClientRect().top > window.innerHeight * 0.9);
    below.forEach((el) => (el.dataset.reveal = "pending"));
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          (e.target as HTMLElement).dataset.reveal = "in";
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    below.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
  return null;
}
