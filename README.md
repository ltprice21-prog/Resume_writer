# Resume Writer

Paste or upload a job description, get back a version of Bo Price's resume rewritten to align with that posting, plus a downloadable, ATS-friendly PDF with its own unique filename.

## How it works

1. **Master resume** (`src/lib/resume.ts`) is the single source of truth — every employer, date, metric, degree and certification lives there.
2. **Tailoring** (`src/lib/tailor.ts`) sends the master resume and the job description to Claude Opus 5, which returns a structured object: a new summary, a selected skills list, and rewritten bullets per role.
3. **Hydration** rebuilds the resume server-side. The model only ever supplies *bullet text, summary and skills*. Company names, job titles, dates, locations, education and certifications are copied from the master data and cannot be altered by the model.
4. **PDF** (`src/lib/pdf.tsx`) renders that resume with `@react-pdf/renderer` and streams it back as a download.

### What the tailoring can and cannot do

Can: reword bullets in the posting's vocabulary, reorder bullets within a role, drop the least relevant bullets, select and order skills, write a targeted summary.

Cannot: invent employers, titles, dates, metrics, tools or skills; reorder or drop jobs (chronology is enforced server-side); change what a bullet factually claims. Requirements you don't have evidence for are reported as **gaps** rather than written into the resume.

## Setup

```bash
npm install
cp .env.example .env.local     # add your ANTHROPIC_API_KEY
npm run dev                    # http://localhost:3000
```

Get an API key at [console.anthropic.com](https://console.anthropic.com/settings/keys). Expect roughly 1–3¢ per tailored resume.

## Deploying to Vercel

Push the repo, import it at [vercel.com/new](https://vercel.com/new), and add `ANTHROPIC_API_KEY` under **Settings → Environment Variables**. No other configuration is required.

The tailoring route declares `maxDuration = 60`. On the Hobby plan the ceiling is 60s, which is comfortably above a typical 20–45s run. If you hit timeouts, set `TAILOR_EFFORT=low` in your environment variables.

## Configuration

| Variable | Required | Notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | Server-side only; never reaches the browser. |
| `TAILOR_EFFORT` | no | `low` \| `medium` \| `high` \| `xhigh` \| `max`. Default `medium`. Higher means better writing, more tokens, slower. |

## Editing your resume

Two options:

- **In the app** — the *Master resume* page edits contact details, bullets, skills and certifications. Changes are saved in that browser only (localStorage) and are sent with each tailoring request.
- **In code** — edit `src/lib/resume.ts`. This is the fallback for any browser without a saved override, so it's the one to change if you want the update to stick everywhere.

The `skills` array is the pool the tailoring step selects from. If a skill isn't listed there or evidenced in a bullet, it won't appear on a tailored resume — add it to the master list first.

## Files and versions

Every generation gets its own id and filename:

```
Bo-Price-Resume-Acme-Freight-Logistics-Coordinator-2026-07-30-a1b2c3d4.pdf
```

Downloads never overwrite each other, and the last 25 generations are listed under **Previous versions** so you can re-open or re-download any of them. History is per-browser; there is no server-side storage of resumes or job descriptions.

## PDF / ATS notes

The template is deliberately plain because applicant tracking systems parse plain documents best:

- Single column, no tables, no text boxes, no images, no icons.
- Core PDF fonts (Helvetica) — real extractable text, not outlines.
- Hyphenation disabled, so a keyword is never split as `docu-mentation` in the text layer.
- No letter-spacing on headings, which otherwise extracts as `S U M M A RY` in some parsers.
- Skills are comma-separated rather than bullet-separated, which splits more reliably.

Output was verified end-to-end against two independent PDF text extractors (pypdf and pdf.js): one page, all five section headings recovered intact, no hyphen breaks.

## Project layout

```
src/
  app/
    page.tsx              tailoring UI, preview, download, version history
    master/page.tsx       master resume editor
    api/tailor/route.ts   job description -> tailored resume (Claude)
    api/pdf/route.ts      tailored resume -> PDF download
    api/parse-jd/route.ts uploaded .pdf/.docx/.txt/.md -> plain text
  lib/
    resume.ts             master resume data
    tailor.ts             prompt, JSON schema, validation, hydration
    pdf.tsx               ATS-friendly PDF template
    filename.ts           unique per-version filenames
    storage.ts            localStorage for master override + history
  components/
    ResumePreview.tsx     on-screen mirror of the PDF
    MatchReport.tsx       coverage, matched/missing keywords, notes
```
