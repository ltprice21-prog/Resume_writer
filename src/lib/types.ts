/** Shared types for the master resume, the tailored output, and the match report. */

export type Link = {
  label: string;
  url: string;
};

export type Role = {
  /** Stable id. The model may only reference these — it can never invent an employer. */
  id: string;
  title: string;
  company: string;
  location?: string;
  start: string;
  end: string;
  bullets: string[];
};

export type Education = {
  degree: string;
  school: string;
  detail?: string;
};

export type MasterResume = {
  name: string;
  location: string;
  email: string;
  phone: string;
  links: Link[];
  /** Optional baseline summary used when no job description has been tailored against. */
  summary?: string;
  roles: Role[];
  education: Education[];
  certifications: string[];
  /**
   * Skills that are evidenced somewhere in the roles above. The tailoring step may
   * select and reorder from this list; it is told not to introduce skills that
   * aren't here or clearly supported by a bullet.
   */
  skills: string[];
};

/** What the model is asked to return. Deliberately narrow. */
export type TailoredPayload = {
  summary: string;
  skills: string[];
  roles: { id: string; bullets: string[] }[];
  analysis: {
    target_title: string;
    target_company: string;
    matched_keywords: string[];
    missing_keywords: string[];
    notes: string[];
  };
};

/** A fully-hydrated resume, safe to render. Employers/dates come from master data. */
export type TailoredResume = {
  name: string;
  location: string;
  email: string;
  phone: string;
  links: Link[];
  summary: string;
  skills: string[];
  roles: Role[];
  education: Education[];
  certifications: string[];
};

export type MatchReport = TailoredPayload["analysis"] & {
  /** Share of extracted job-description keywords that appear in the tailored resume. */
  coverage: number;
};

export type TailorResponse = {
  resume: TailoredResume;
  report: MatchReport;
  /** Unique id for this generation, also embedded in the PDF filename. */
  versionId: string;
  createdAt: string;
  filename: string;
};
