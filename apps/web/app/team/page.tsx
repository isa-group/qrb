import {
  ArrowRight,
  Envelope,
  GithubLogo,
  Globe,
  GraduationCap,
  LinkedinLogo,
} from "@phosphor-icons/react/dist/ssr";
import type { Metadata } from "next";
import Link from "next/link";

import { CopyButton } from "@/components/copy-button";
import { OrcidMark } from "@/components/orcid-mark";
import { TEAM, type Person } from "@/data/team";

import styles from "./team.module.css";

export const metadata: Metadata = {
  title: "Team · QRB",
  description:
    "The authors of the ICSOC 2026 paper behind QRB and the author of OpenBinding, at SCORE Lab, I3US, Universidad de Sevilla.",
};

/** The person's profiles, in a fixed order; a missing one is left out. */
function profiles(p: Person) {
  const out: { label: string; href: string; icon: React.ReactNode }[] = [];
  if (p.scholar)
    out.push({
      label: "Google Scholar",
      href: `https://scholar.google.com/citations?user=${p.scholar}`,
      icon: <GraduationCap size={16} aria-hidden />,
    });
  if (p.orcid)
    out.push({ label: "ORCID", href: `https://orcid.org/${p.orcid}`, icon: <OrcidMark /> });
  if (p.github)
    out.push({
      label: "GitHub",
      href: `https://github.com/${p.github}`,
      icon: <GithubLogo size={16} weight="fill" aria-hidden />,
    });
  if (p.linkedin)
    out.push({
      label: "LinkedIn",
      href: `https://www.linkedin.com/in/${p.linkedin}`,
      icon: <LinkedinLogo size={16} weight="fill" aria-hidden />,
    });
  if (p.website)
    out.push({ label: "Website", href: p.website, icon: <Globe size={16} aria-hidden /> });
  return out;
}

function Portrait({ p }: { p: Person }) {
  if (p.photo)
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img className={styles.portrait} src={p.photo} alt="" width={96} height={96} loading="lazy" />
    );
  return (
    <span className={`${styles.portrait} ${styles.monogram} heading-5`} aria-hidden>
      {p.initials}
    </span>
  );
}

export default function TeamPage() {
  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1 className="heading-3">Team</h1>
        <p className={`${styles.lead} title-2 soft`}>
          QRB is the research artifact of an ICSOC 2026 paper, built at SCORE Lab, I3US,
          Universidad de Sevilla.
        </p>
      </header>

      <ul className={styles.people}>
        {TEAM.map((p) => {
          const links = profiles(p);
          return (
            <li key={p.slug} id={p.slug} className={styles.person}>
              <div className={styles.who}>
                <Portrait p={p} />
                <div className={styles.name}>
                  <h2 className="heading-6">{p.name}</h2>
                  <p className="caption-2 muted">{p.affiliation}</p>
                </div>
              </div>
              <div className={styles.body}>
                <p className="title-2 soft">{p.role}</p>
                {p.email && (
                  <div className={styles.email}>
                    <a className="btn btn-secondary button-sm" href={`mailto:${p.email}`}>
                      <Envelope size={16} aria-hidden />
                      {p.email}
                    </a>
                    <CopyButton text={p.email} name={`${p.name}'s email address`} />
                  </div>
                )}
                {links.length > 0 && (
                  <ul className={styles.links} aria-label={`${p.name} elsewhere`}>
                    {links.map((l) => (
                      <li key={l.label}>
                        <a className="btn btn-secondary button-sm" href={l.href}>
                          {l.icon}
                          {l.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <footer className={styles.foot}>
        <p className="body-6 muted">Using QRB in your work? Cite the paper and the artifact.</p>
        <Link href="/#cite" className="link body-5">
          How to cite <ArrowRight size={16} aria-hidden />
        </Link>
      </footer>
    </div>
  );
}
