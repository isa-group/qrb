import { readFileSync } from "node:fs";
import path from "node:path";

import { ArrowRight, CaretDown } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";

import { CopyButton } from "@/components/copy-button";
import { highlight, type Lang } from "@/components/highlight";
import { HeroScene } from "@/components/landing/hero-scene";
import styles from "@/components/landing/landing.module.css";
import { RevealObserver } from "@/components/landing/reveal-observer";
import {
  CatalogScene,
  type PresetWinner,
} from "@/components/landing/catalog-scene";
import { Tagline } from "@/components/landing/tagline";
import presetsFixture from "@/fixtures/presets.json";
import selectNormal from "@/fixtures/select-normal.json";
import selectCostOnly from "@/fixtures/select-cost-only.json";
import selectFastest from "@/fixtures/select-preset-fastest.json";
import selectFidelityFirst from "@/fixtures/select-preset-fidelity-first.json";

// ---------- content (source: .impeccable/briefs/landing-copy.md) ----------

const DOI = "10.5281/zenodo.21442195";
const REPO = "https://github.com/isa-group/qrb";

const STEPS = [
  {
    input: "Quantum task, objective & constraints",
    service: "selection request",
    text: "Your OpenQASM 3 circuit, the features you weight, and the limits you will not cross.",
  },
  {
    input: "Resource properties",
    service: "resource catalog",
    text: "Live properties of IBM Quantum and Amazon Braket QPUs, or the frozen snapshot.",
  },
  {
    input: "Transpiled circuits",
    service: "transpilation service",
    text: "Your circuit, compiled for every candidate QPU.",
  },
  {
    input: "Resource features",
    service: "feature calculation service",
    text: "Expected fidelity and depth, computed from your transpiled circuit rather than the datasheet, plus each QPU’s queue and estimated cost.",
  },
  {
    input: "BIM instance",
    service: "instance builder",
    text: "One Binding Instance Model: candidates, features, constraints, objective.",
  },
  {
    input: "Optimal binding",
    service: "OpenBinding",
    text: "Solved exactly. You get the binding, every candidate’s features and, for each excluded candidate, the constraint it broke.",
  },
];

const RQ2_FACTS = [
  {
    figure: "390/390",
    text: "Feasible set matched the ground truth in every run.",
  },
  {
    figure: "105/105",
    text: "Returned binding equal to the independently recomputed optimum.",
  },
  {
    figure: "66 → 5",
    text: "66 preference weightings yield five distinct optimal bindings.",
  },
  {
    figure: "0.72 s",
    text: "Median OpenBinding resolution time over 390 runs. It stays constant.",
  },
];

const PRESETS = [
  { id: "nisq-analyzer", name: "NISQ Analyzer" },
  { id: "q-orchestrator", name: "Q-Orchestrator" },
  { id: "mqt-predictor", name: "MQT Predictor" },
];

const FAQ = [
  {
    q: "Does QRB run my circuit?",
    a: "No. QRB only selects. It never submits jobs to a provider and incurs no charges.",
  },
  {
    q: "What does “optimal” mean here?",
    a: "Optimal for the weights and constraints you declare, over features estimated from the catalog. Change the weights and the optimum can change; Experiment 3 found five distinct optimal bindings across 66 weightings. It is never a claim that a QPU is the best in general.",
  },
  {
    q: "Where do the features come from?",
    a: "Expected fidelity and depth are computed from your circuit, transpiled for each candidate, using the provider’s reported calibration. Queue comes from the provider. Cost is estimated from public rate cards.",
  },
  {
    q: "Which providers and QPUs are covered?",
    a: "Gate based QPUs on IBM Quantum and Amazon Braket. The frozen snapshot used in the paper has 12: 6 IBM Quantum and 6 Amazon Braket, captured 2026-07-11 19:13 UTC.",
  },
  {
    q: "Is the data live?",
    a: "Yes. Bind always uses live provider data and shows when it was fetched. If the providers cannot be reached, Bind says so instead of answering from older data. The paper’s results use the frozen snapshot captured on 2026-07-11.",
  },
  {
    q: "Who solves the problem?",
    a: "OpenBinding, a generic solver gateway for QoS aware composition. QRB builds the BIM instance; it implements no selection logic itself.",
  },
  {
    q: "Can it compose multi step quantum workflows?",
    a: "Not as evaluated. The paper evaluates single task binding. BIM can express more, and RQ1 includes a two task variant of the motivating scenario, but workflow composition is not a claim of this work.",
  },
];

const BIB_PAPER = `@inproceedings{romeroflores2026qrs,
  author    = {Romero-Flores, Adri{\\'a}n and M{\\'a}rquez-Chamorro, Alfonso E.
               and Parejo, Jos{\\'e} Antonio and Ruiz-Cort{\\'e}s, Antonio},
  title     = {Quantum Resource Selection as a {QoS}-Aware Composition Problem},
  booktitle = {Service-Oriented Computing -- 24th International Conference,
               {ICSOC} 2026},
  series    = {Lecture Notes in Computer Science},
  publisher = {Springer},
  year      = {2026},
  note      = {In press}
}`;

const BIB_ARTIFACT = `@misc{romeroflores2026qrs_artifact,
  author = {Romero-Flores, Adri{\\'a}n and M{\\'a}rquez-Chamorro, Alfonso E.
            and Parejo, Jos{\\'e} Antonio and Ruiz-Cort{\\'e}s, Antonio},
  title  = {Supplementary Material for \`\`Quantum Resource Selection as a
            {QoS}-Aware Composition Problem''},
  year   = {2026},
  doi    = {10.5281/zenodo.21442195}
}`;

// ---------- the API example, read from the saved fixtures (values unedited) ----------

const CURL = readFileSync(
  path.join(process.cwd(), "fixtures/select-normal.curl.sh"),
  "utf8",
)
  .split("\n")
  .filter((l) => !l.startsWith("#"))
  .join("\n")
  .trim();

function responseExcerpt(): string {
  const r = selectNormal;
  const sol = r.result.solutions[0];
  const chosen = r.candidates.find((c) => c.selected)!;
  const excluded = r.candidates.find((c) => c.violated_constraints.length > 0)!;
  const v = excluded.violated_constraints[0];
  const j = (x: unknown) => JSON.stringify(x);
  return [
    "{",
    `  "result": {`,
    `    "feasibility": ${j(r.result.feasibility)},`,
    `    "solutions": [{ "binding": ${j(sol.binding).replace("{", "{ ").replace("}", " }").replace(":", ": ")}, … }],`,
    `    "provenance": { "engine_id": ${j(r.result.provenance.engine_id)}, … }`,
    `  },`,
    `  "source": { "mode": ${j(r.source.mode)}, "as_of": ${j(r.source.as_of)}, "cache_hit": ${j(r.source.cache_hit)} },`,
    `  "candidates": [`,
    `    { "candidate_id": ${j(chosen.candidate_id)}, "selected": true, … },`,
    `    { "candidate_id": ${j(excluded.candidate_id)}, "selected": false,`,
    `      "violated_constraints": [{ "feature": ${j(v.feature)}, "op": ${j(v.op)}, "value": ${v.value.toFixed(1)}, "actual": ${v.actual.toFixed(1)}, … }], … },`,
    `    …`,
    `  ],`,
    `  "timings_ms": { … }`,
    "}",
  ].join("\n");
}

const RESPONSE = responseExcerpt();
const N_CANDIDATES = selectNormal.candidates.length;

// ---------- the catalog floor: three preferences, three different winners (saved API answers) ----------

const WEIGHT_LABELS: Record<string, string> = {
  expected_fidelity: "Fidelity",
  cost: "Cost",
  queue: "Queue",
  critical_depth: "Critical depth",
  estimated_success_probability: "Success probability",
};
const PRESET_WEIGHTS = presetsFixture.result as Record<
  string,
  { weights: Record<string, number> }
>;

/** A saved /select answer, with the weights it was asked with and the /bind link that repeats them. */
function winnerOf(
  name: string,
  weights: Record<string, number>,
  href: string,
  response: typeof selectFidelityFirst,
): PresetWinner {
  const chosen = response.candidates.find((c) => c.selected)!;
  return {
    key: href,
    name,
    href,
    weights: Object.entries(weights).map(([k, v]) => ({
      label: WEIGHT_LABELS[k] ?? k,
      share: Math.round(v * 100),
    })),
    candidateId: chosen.candidate_id,
    qpu: chosen.name,
    provider: chosen.provider_id,
  };
}

const WINNERS: PresetWinner[] = [
  winnerOf(
    "Fidelity first",
    PRESET_WEIGHTS["fidelity-first"].weights,
    "/bind?preset=fidelity-first",
    selectFidelityFirst,
  ),
  // Illustrative: shows the cost-only answer so the three differ; the cheapest preset itself returns
  // ibm_aachen on the snapshot (the section has no caption, by the author's choice).
  winnerOf(
    "Cheapest",
    PRESET_WEIGHTS.cheapest.weights,
    "/bind?preset=cheapest",
    selectCostOnly,
  ),
  winnerOf(
    "Queue first",
    PRESET_WEIGHTS.fastest.weights,
    "/bind?preset=fastest",
    selectFastest,
  ),
];

const FAQ_LD = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ.map((f) => ({
    "@type": "Question",
    name: f.q,
    acceptedAnswer: { "@type": "Answer", text: f.a },
  })),
};

// ---------- page ----------

function SectionHead({
  id,
  title,
  lead,
}: {
  id: string;
  title: string;
  lead?: string;
}) {
  return (
    <header className={styles.head} data-reveal>
      <h2 id={id} className="heading-2">
        {title}
      </h2>
      {lead && <p className={`${styles.lead} title-2 soft`}>{lead}</p>}
    </header>
  );
}

function Code({
  code,
  label,
  copy,
  lang,
}: {
  code: string;
  label: string;
  copy?: string;
  lang?: Lang;
}) {
  return (
    <figure className={styles.code}>
      <figcaption className={styles.codeBar}>
        <span className="caption-2 muted">{label}</span>
        <CopyButton text={copy ?? code} name={label} />
      </figcaption>
      <pre tabIndex={0} aria-label={label}>
        <code>{lang ? highlight(code, lang) : code}</code>
      </pre>
    </figure>
  );
}

export default function LandingPage() {
  return (
    <>
      <RevealObserver />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_LD) }}
      />

      {/* Hero */}
      <section className={styles.hero} aria-labelledby="hero-title" data-hero>
        <HeroScene />
        <div className={styles.heroCopy}>
          <h1
            id="hero-title"
            className={`${styles.heroTitle} heading-1`}
          >
            <span className={styles.heroLine}>Declare what matters.</span>{" "}
            <span className={styles.heroLine}>Get the right QPU for it.</span>
          </h1>
          <p className={`${styles.heroSub} title-2 soft`}>
            Give QRB an OpenQASM 3 circuit and the preferences you care about.
            It returns the IBM Quantum or Amazon Braket QPU that is optimal for
            them, without running anything.
          </p>
          <div className={styles.heroAction}>
            <Link href="/bind" className="btn btn-primary button-md">
              Bind a circuit
            </Link>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className={styles.section} aria-labelledby="how">
        <div className={styles.inner}>
          <SectionHead
            id="how"
            title="From circuit to binding in six steps"
            lead="QRB models resource selection as QoS aware service composition. It gathers the facts, builds a standard BIM instance, and hands it to OpenBinding, which does the solving. QRB implements no selection logic of its own."
          />
          <ol className={styles.steps}>
            {STEPS.map((s, i) => (
              <li
                key={s.input}
                className={styles.step}
                data-reveal
                style={{ transitionDelay: `${(i % 3) * 80}ms` }}
              >
                <h3 className={`${styles.stepFlow} heading-6`}>
                  <span className={styles.stepIndex} aria-hidden>
                    {i + 1}
                  </span>
                  {s.input}
                </h3>
                <p className="body-3 soft">{s.text}</p>
                <p className="caption-2 muted">Via {s.service}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Tagline reveal */}
      <section className={styles.taglineSection} aria-label="What QRB does">
        <div className={`${styles.inner} ${styles.taglineGrid}`}>
          <Tagline
            lines={[
              "Change the weights, and the optimal resource changes with them.",
              "QRB shows why each one wins or loses, and never runs a single job.",
            ]}
          />
          <CatalogScene winners={WINNERS} />
        </div>
      </section>

      {/* Results */}
      <section className={styles.section} aria-labelledby="results">
        <div className={styles.inner}>
          <SectionHead
            id="results"
            title="What the paper shows"
            lead="Three research questions, each checked by the artifact."
          />

          <div className={styles.rq} data-reveal>
            <div className={styles.rqLabel}>
              <h3 className="heading-5">
                RQ1
                <span className={styles.rqSep} aria-hidden>
                  {" · "}
                </span>
                <span className={styles.rqName}>Expressiveness</span>
              </h3>
              <p className="caption-2 muted">Sec. 4</p>
            </div>
            <div className={styles.rqBody}>
              <p className={`${styles.figure} heading-2`}>6/6</p>
              <p className="body-3 soft">
                The motivating scenario’s BIM instances match the paper.
                OpenBinding resolves them, and a two task variant, unchanged.
              </p>
            </div>
          </div>

          <div className={styles.rq} data-reveal>
            <div className={styles.rqLabel}>
              <h3 className="heading-5">
                RQ2
                <span className={styles.rqSep} aria-hidden>
                  {" · "}
                </span>
                <span className={styles.rqName}>Correctness and cost</span>
              </h3>
              <p className="caption-2 muted">Secs. 5.4–5.5</p>
            </div>
            <div className={styles.rqBody}>
              <dl className={styles.facts}>
                {RQ2_FACTS.map((f) => (
                  <div key={f.figure}>
                    <dt className={`${styles.figure} heading-3`}>{f.figure}</dt>
                    <dd className="body-6 soft">{f.text}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>

          <div className={styles.rq} data-reveal>
            <div className={styles.rqLabel}>
              <h3 className="heading-5">
                RQ3
                <span className={styles.rqSep} aria-hidden>
                  {" · "}
                </span>
                <span className={styles.rqName}>Generality</span>
              </h3>
              <p className="caption-2 muted">Sec. 5.6</p>
            </div>
            <div className={styles.rqBody}>
              <p className="body-3 soft">
                NISQ Analyzer, Q-Orchestrator and MQT Predictor, re-expressed as
                BIM instances. Each is available as a preset in Bind.
              </p>
              <ul className={styles.presets}>
                {PRESETS.map((p) => (
                  <li key={p.id}>
                    <Link
                      href={`/bind?preset=${p.id}`}
                      className="btn btn-secondary button-sm"
                    >
                      {p.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <p className={`${styles.scope} caption-2 muted`}>
            Evaluated for single task binding over a catalog snapshot. Bindings
            are optimal for the declared preferences over estimated features,
            not for measured outcomes.
          </p>
        </div>
      </section>

      {/* API */}
      <section className={styles.section} aria-labelledby="api">
        <div className={styles.inner}>
          <SectionHead
            id="api"
            title="One request, the whole answer"
            lead="The same API powers Bind. Send a circuit and preferences; get the binding, every candidate’s features, the constraint each excluded candidate broke, and whether the data is live or from the snapshot."
          />
          <div className={styles.api} data-reveal>
            <Code code={CURL} label="POST /select" lang="shell" />
            <Code
              code={RESPONSE}
              label="Response, excerpt"
              copy={JSON.stringify(selectNormal, null, 2)}
              lang="json"
            />
          </div>
          <div className={styles.apiFoot} data-reveal>
            <div className={styles.apiNotes}>
              <p className="caption-2 muted">
                A real response from the frozen snapshot: {N_CANDIDATES}{" "}
                candidates.
              </p>
              <p className="caption-2 muted">
                Calls without a key share a daily budget per IP address.{" "}
                <Link href="/signin" className="link body-5">
                  Sign in for a key with a budget of its own{" "}
                  <ArrowRight size={16} aria-hidden />
                </Link>
              </p>
            </div>
            <Link href="/docs" className="btn btn-secondary button-md">
              Explore the API
            </Link>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className={styles.section} aria-labelledby="faq">
        <div className={`${styles.inner} ${styles.faqGrid}`}>
          <SectionHead id="faq" title="Questions" />
          <div className={styles.faq} data-reveal>
            {FAQ.map((f) => (
              <details key={f.q} name="faq" className={styles.qa}>
                <summary className="title-1">
                  {f.q}
                  <CaretDown size={20} aria-hidden className={styles.caret} />
                </summary>
                <p className="body-3 soft">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Cite */}
      <section className={styles.section} aria-labelledby="cite">
        <div className={styles.inner}>
          <SectionHead
            id="cite"
            title="Cite QRB"
            lead="Paper in press (LNCS); volume and pages to follow."
          />
          <div className={styles.cite} data-reveal>
            <Code code={BIB_PAPER} label="The paper" />
            <Code code={BIB_ARTIFACT} label="The artifact" />
          </div>
          <div className={styles.citeLinks} data-reveal>
            <a
              className="btn btn-secondary button-md"
              href={`https://doi.org/${DOI}`}
            >
              Artifact on Zenodo
            </a>
            <span
              className="btn btn-secondary button-md"
              role="link"
              aria-disabled="true"
              title="Available once the paper is published"
            >
              Read the paper (in press)
            </span>
            <p className="caption-2 muted">
              DOI {DOI}. GitHub also offers “Cite this repository” from
              CITATION.cff.
            </p>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className={styles.final} aria-labelledby="final">
        <div className={styles.inner} data-reveal>
          <h2 id="final" className="heading-2">
            Have a circuit? Find its optimal binding.
          </h2>
          <Link href="/bind" className="btn btn-primary button-md">
            Bind a circuit
          </Link>
        </div>
      </section>

      <footer className={styles.footer}>
        <div className={`${styles.inner} ${styles.footerRow} body-6 muted`}>
          <div className={styles.footerBrand}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={styles.footerMark} src="/brand/qrb-lockup-mono-white.svg" alt="" width={73} height={24} />
            <p>
              <span className="soft">QRB, Quantum Resource Binder</span> · SCORE
              Lab, Universidad de Sevilla · ICSOC 2026 (LNCS, in press)
            </p>
          </div>
          <ul className={styles.footerLinks}>
            <li>
              <Link href="/team">Team</Link>
            </li>
            <li>
              <a href={REPO}>GitHub</a>
            </li>
            <li>
              <a href={`https://doi.org/${DOI}`}>DOI {DOI}</a>
            </li>
            <li>
              <a href={`${REPO}/blob/main/LICENSE`}>Apache-2.0</a>
            </li>
          </ul>
        </div>
      </footer>
    </>
  );
}
