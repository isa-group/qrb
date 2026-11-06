/**
 * The people on /team: the four authors of the ICSOC 2026 paper in citation order (CITATION.cff),
 * then the author of OpenBinding. Every link was checked against a public source (ORCID records,
 * Google Scholar, SISIUS, GitHub, the SPHERE team page); a field left out is not shown, never guessed.
 */
export type Person = {
  slug: string;
  name: string;
  /** Initials for the monogram shown when there is no photo. */
  initials: string;
  /** What they are on QRB. */
  role: string;
  affiliation: string;
  /** Square portrait in public/team/, 256px. */
  photo?: string;
  email?: string;
  scholar?: string;
  orcid?: string;
  github?: string;
  linkedin?: string;
  website?: string;
};

const SCORE = "SCORE Lab, I3US, Universidad de Sevilla";

export const TEAM: Person[] = [
  {
    slug: "adrian-romero-flores",
    name: "Adrián Romero-Flores",
    initials: "AR",
    role: "Core researcher",
    affiliation: SCORE,
    email: "aromero17@us.es",
    photo: "/team/adrian-romero-flores.webp",
    scholar: "ivrCKLEAAAAJ",
    orcid: "0009-0009-3755-1731",
    github: "adrrf",
    linkedin: "adrrf",
    website: "https://adrianromero.pages.dev/",
  },
  {
    slug: "alfonso-marquez-chamorro",
    name: "Alfonso E. Márquez-Chamorro",
    initials: "AM",
    role: "Core researcher",
    affiliation: SCORE,
    email: "amarquez6@us.es",
    photo: "/team/alfonso-marquez-chamorro.webp",
    scholar: "1hZSDcgAAAAJ",
    orcid: "0000-0002-8243-0404",
  },
  {
    slug: "jose-antonio-parejo",
    name: "José Antonio Parejo",
    initials: "JP",
    role: "Core researcher",
    affiliation: SCORE,
    email: "japarejo@us.es",
    photo: "/team/jose-antonio-parejo.webp",
    scholar: "1vZmkFIAAAAJ",
    orcid: "0000-0002-4708-4606",
    github: "japarejo",
    linkedin: "jose-antonio-parejo-maestre-a1738a8",
  },
  {
    slug: "antonio-ruiz-cortes",
    name: "Antonio Ruiz-Cortés",
    initials: "AR",
    role: "Core researcher",
    affiliation: SCORE,
    email: "aruiz@us.es",
    photo: "/team/antonio-ruiz-cortes.webp",
    scholar: "Ka-FHBQAAAAJ",
    orcid: "0000-0001-9827-1834",
    github: "antonioruizcortes",
    linkedin: "antonioruizcortes",
  },
  {
    slug: "javier-cavero",
    name: "Javier Cavero",
    initials: "JC",
    role: "Author of OpenBinding",
    affiliation: SCORE,
    email: "fcavero@us.es",
    photo: "/team/javier-cavero.webp",
    scholar: "vDBqkIkAAAAJ",
    orcid: "0009-0004-2453-8814",
    github: "javiercavlop",
  },
];
