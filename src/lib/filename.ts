import { randomBytes } from "node:crypto";

function slug(value: string, fallback: string): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 40) || fallback;
}

/** Short, URL-safe, collision-resistant id for one generated version. */
export function newVersionId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * Every generation gets its own filename, so downloads never overwrite one
 * another and each application can be traced back to the version that was sent.
 * e.g. Bo-Price-Resume-Acme-Logistics-Coordinator-2026-07-30-a1b2c3d4.pdf
 */
export function buildFilename(opts: {
  name: string;
  company: string;
  title: string;
  versionId: string;
  date?: Date;
}): string {
  const date = (opts.date ?? new Date()).toISOString().slice(0, 10);
  const parts = [
    slug(opts.name, "Resume"),
    "Resume",
    slug(opts.company === "Unknown" ? "" : opts.company, ""),
    slug(opts.title === "Unknown" ? "" : opts.title, ""),
    date,
    opts.versionId,
  ].filter(Boolean);
  return `${parts.join("-")}.pdf`;
}
