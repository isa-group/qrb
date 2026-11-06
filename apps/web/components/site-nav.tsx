"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { UserStatus } from "./account/user-status";
import styles from "./site-nav.module.css";

const LINKS = [
  { href: "/bind", label: "Bind" },
  { href: "/catalog", label: "Catalog" },
  { href: "/docs", label: "Explore the API" },
];

/**
 * Floating nav that morphs. At the very top of a page it is bare text at the content's left edge (the
 * wordmark with the links beside it); once the page scrolls, the items glide to the middle and the
 * blurred pill forms around them. On the landing page, once the hero has left the
 * screen, "Bind a circuit" grows in at the pill's end, so there is never more than one violet button
 * in view. Everything moves with transform and opacity.
 */
export function SiteNav() {
  const pathname = usePathname();
  const landing = pathname === "/";
  const [open, setOpen] = useState(false);
  const [condensed, setCondensed] = useState(false);
  const [heroGone, setHeroGone] = useState(false);
  const cta = useRef<HTMLAnchorElement>(null);
  const bar = useRef<HTMLElement>(null);
  const mark = useRef<HTMLAnchorElement>(null);
  const links = useRef<HTMLUListElement>(null);

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  // Condense as soon as the page has scrolled: a sentinel at the very top stands in for "scrolled".
  useEffect(() => {
    const s = document.createElement("div");
    s.setAttribute("aria-hidden", "true");
    Object.assign(s.style, {
      position: "absolute",
      top: "0",
      left: "0",
      width: "1px",
      height: "16px",
      pointerEvents: "none",
    });
    document.body.prepend(s);
    const io = new IntersectionObserver(([e]) =>
      setCondensed(!e.isIntersecting),
    );
    io.observe(s);
    return () => {
      io.disconnect();
      s.remove();
    };
  }, [pathname]);

  // Landing only: the button joins once the hero (and its own violet button) has left the screen.
  useEffect(() => {
    setHeroGone(false);
    if (!landing) return;
    const hero = document.querySelector<HTMLElement>("[data-hero]");
    if (!hero) return;
    const io = new IntersectionObserver(
      ([e]) => setHeroGone(!e.isIntersecting),
      { rootMargin: "-80px 0px 0px 0px" },
    );
    io.observe(hero);
    return () => io.disconnect();
  }, [landing, pathname]);

  // Geometry for the morph, measured from the untransformed layout (offsets ignore transforms):
  // - the button's slot, which the condensed bar shifts by half while the button is hidden;
  // - how far the wordmark and links travel to the content's left edge in the spread state.
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const measure = () => {
      const gap = parseFloat(getComputedStyle(el).columnGap || "0");
      const slot = cta.current ? cta.current.offsetWidth + gap : 0;
      el.style.setProperty("--cta-slot", `${slot}px`);
      el.style.setProperty("--cta-shift", `${slot / 2}px`);
      const root = getComputedStyle(document.documentElement);
      const g = parseFloat(root.getPropertyValue("--gutter")) || 0;
      const max = parseFloat(root.getPropertyValue("--max")) || 1248;
      const vw = document.documentElement.clientWidth;
      const left = Math.max(0, (vw - max - 2 * g) / 2) + g;
      // While the button is hidden the visible items are centred, so the bar sits shifted right.
      const barLeft = (vw - el.offsetWidth) / 2 + (landing ? slot / 2 : 0);
      // Spread state: the wordmark and links sit together at the content's left edge.
      if (mark.current)
        el.style.setProperty(
          "--spread",
          `${left - (barLeft + mark.current.offsetLeft)}px`,
        );
    };
    // Placed without motion: transitions are off while the geometry changes (first paint, a
    // resize, the account entry appearing once the session is known) and come back two frames
    // later, so the bar never slides into a new position by itself.
    let raf = 0;
    const place = () => {
      el.removeAttribute("data-measured");
      measure();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => (raf = requestAnimationFrame(() => el.setAttribute("data-measured", ""))));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [landing]);

  const current = (href: string) =>
    pathname.startsWith(href) ? "page" : undefined;
  const ctaOn = landing && heroGone;

  return (
    <header className={styles.wrap}>
      <nav
        ref={bar}
        className={styles.bar}
        aria-label="Main"
        data-condensed={condensed || open}
        data-cta={landing ? (ctaOn ? "on" : "off") : undefined}
      >
        <Link
          ref={mark}
          href="/"
          className={styles.mark}
          aria-current={landing ? "page" : undefined}
        >
          {/* The colour lockup (brand/logo/svg/qrb-lockup-color-on-dark.svg): fixed size, so the
              nav's measured spread does not move while the image loads. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/qrb-lockup-color-on-dark.svg" alt="QRB" width={73} height={24} />
        </Link>
        <ul ref={links} className={styles.links}>
          {LINKS.map((l) => (
            <li key={l.href}>
              <Link
                href={l.href}
                className={`${styles.link} title-4`}
                aria-current={current(l.href)}
              >
                {l.label}
              </Link>
            </li>
          ))}
          <li className={styles.account}>
            <UserStatus />
          </li>
        </ul>
        {landing && (
          <Link
            ref={cta}
            href="/bind"
            className={`${styles.cta} btn btn-primary button-sm`}
            aria-hidden={!ctaOn}
            tabIndex={ctaOn ? undefined : -1}
          >
            Bind a circuit
          </Link>
        )}
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          aria-controls="mobile-menu"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((v) => !v)}
          data-open={open}
        >
          <span />
          <span />
        </button>
      </nav>
      <div
        id="mobile-menu"
        className={styles.panel}
        data-open={open}
        hidden={!open}
      >
        <ul>
          <li style={{ ["--i" as string]: 0 }}>
            <Link
              href="/"
              className="heading-3"
              aria-current={landing ? "page" : undefined}
              onClick={() => setOpen(false)}
            >
              Home
            </Link>
          </li>
          {LINKS.map((l, i) => (
            <li key={l.href} style={{ ["--i" as string]: i + 1 }}>
              <Link
                href={l.href}
                className="heading-3"
                aria-current={current(l.href)}
                onClick={() => setOpen(false)}
              >
                {l.label}
              </Link>
            </li>
          ))}
          <li style={{ ["--i" as string]: LINKS.length + 1 }}>
            <UserStatus variant="menu" onNavigate={() => setOpen(false)} />
          </li>
        </ul>
      </div>
    </header>
  );
}
