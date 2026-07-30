import Anthropic from "@anthropic-ai/sdk";
import type {
  MasterResume,
  MatchReport,
  TailoredPayload,
  TailoredResume,
} from "./types";

/**
 * Claude Opus 5. Thinking is on by default on this model, which is what we want
 * for a rewrite task — it plans the mapping from job description to bullets
 * before writing. Effort is tunable via TAILOR_EFFORT; "medium" keeps a single
 * tailoring pass comfortably inside a serverless request window.
 */
const MODEL = "claude-opus-5";
const EFFORT = (process.env.TAILOR_EFFORT ?? "medium") as
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export class TailorError extends Error {}

const SYSTEM_PROMPT = `You are a resume editor. You rewrite one specific person's resume so it aligns with a specific job description.

The master resume is the only source of truth about this candidate. You may:
- Reword bullets in the vocabulary the job description uses.
- Reorder bullets within a role so the most relevant appear first.
- Drop the least relevant bullets from a role.
- Select and order skills.
- Write a new professional summary.

You may NOT:
- Invent or alter employers, job titles, dates, locations, degrees, or certifications.
- Invent metrics, numbers, dollar amounts, team sizes, percentages, or tools. Every number you write must already appear in the master resume for that same role.
- Claim a skill, system, or responsibility the master resume does not evidence. If the job asks for something the candidate lacks, leave it out of the resume and list it under missing_keywords instead.
- Change what a bullet factually claims. "Coordinated shipments" must not become "Directed a shipping department."

Writing rules:
- Every bullet starts with a strong past-tense verb, except the current role, which may use present tense.
- One idea per bullet. Aim for 1-2 lines of printed text each; never longer than about 30 words.
- Keep 2-5 bullets per role. Give the most job-relevant roles the most bullets.
- Mirror the job description's exact terminology where the candidate genuinely has the experience (e.g. write "3PL" if the posting says "3PL" and the candidate coordinated third-party logistics).
- No first-person pronouns, no buzzword padding ("results-driven", "team player", "synergy"), no adverb inflation.
- The summary is 2-3 sentences: what the candidate does, the experience that matters most for this posting, and one concrete proof point drawn from the resume.
- Skills must be short noun phrases (2-5 words), ordered by relevance to the posting. Return 8-12.

Return only the structured object. Reference each role by its exact id.`;

function buildSchema(roleIds: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "skills", "roles", "analysis"],
    properties: {
      summary: {
        type: "string",
        description: "2-3 sentence professional summary targeted at this posting.",
      },
      skills: {
        type: "array",
        description: "8-12 short skill phrases, most job-relevant first.",
        items: { type: "string" },
      },
      roles: {
        type: "array",
        description:
          "One entry per role in the master resume, same ids, 2-5 rewritten bullets each.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "bullets"],
          properties: {
            id: { type: "string", enum: roleIds },
            bullets: { type: "array", items: { type: "string" } },
          },
        },
      },
      analysis: {
        type: "object",
        additionalProperties: false,
        required: [
          "target_title",
          "target_company",
          "matched_keywords",
          "missing_keywords",
          "notes",
        ],
        properties: {
          target_title: {
            type: "string",
            description: "Job title from the posting, or 'Unknown' if absent.",
          },
          target_company: {
            type: "string",
            description: "Hiring company from the posting, or 'Unknown' if absent.",
          },
          matched_keywords: {
            type: "array",
            description:
              "Requirements from the posting that the tailored resume genuinely demonstrates.",
            items: { type: "string" },
          },
          missing_keywords: {
            type: "array",
            description:
              "Requirements from the posting the candidate has no evidence for. Be honest here.",
            items: { type: "string" },
          },
          notes: {
            type: "array",
            description:
              "2-5 short, specific notes for the candidate: gaps worth addressing, angles to emphasise in a cover letter or interview.",
            items: { type: "string" },
          },
        },
      },
    },
  } as const;
}

function renderMaster(master: MasterResume): string {
  const roles = master.roles
    .map((r) =>
      [
        `<role id="${r.id}">`,
        `title: ${r.title}`,
        `company: ${r.company}`,
        `dates: ${r.start} – ${r.end}`,
        r.location ? `location: ${r.location}` : null,
        "bullets:",
        ...r.bullets.map((b) => `- ${b}`),
        "</role>",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");

  return [
    `name: ${master.name}`,
    `location: ${master.location}`,
    "",
    "EXPERIENCE (oldest-to-newest order is preserved on output; do not reorder roles)",
    roles,
    "",
    "EDUCATION",
    ...master.education.map(
      (e) => `- ${e.degree} — ${e.school}${e.detail ? ` (${e.detail})` : ""}`,
    ),
    "",
    "CERTIFICATIONS AND LICENSES",
    ...master.certifications.map((c) => `- ${c}`),
    "",
    "EVIDENCED SKILLS (select and order from this list; do not add skills absent from the resume)",
    ...master.skills.map((s) => `- ${s}`),
  ].join("\n");
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new TailorError(`${field} was not an array.`);
  const out = value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
  return out;
}

/** Validates the model's payload and rebuilds a resume from trusted master data. */
export function hydrate(
  master: MasterResume,
  payload: TailoredPayload,
): { resume: TailoredResume; report: MatchReport } {
  if (typeof payload.summary !== "string" || !payload.summary.trim()) {
    throw new TailorError("The model returned an empty summary.");
  }
  if (!Array.isArray(payload.roles)) {
    throw new TailorError("The model returned no roles.");
  }

  const byId = new Map(
    payload.roles
      .filter((r) => r && typeof r.id === "string")
      .map((r) => [r.id, asStringArray(r.bullets, `roles[${r.id}].bullets`)]),
  );

  // Master order and master facts win. The model only supplies bullet text.
  const roles = master.roles.map((role) => {
    const rewritten = byId.get(role.id);
    return {
      ...role,
      bullets:
        rewritten && rewritten.length > 0
          ? rewritten.slice(0, 6)
          : role.bullets,
    };
  });

  const analysis = payload.analysis ?? ({} as TailoredPayload["analysis"]);
  const matched = asStringArray(analysis.matched_keywords ?? [], "matched_keywords");
  const missing = asStringArray(analysis.missing_keywords ?? [], "missing_keywords");
  const total = matched.length + missing.length;

  const resume: TailoredResume = {
    name: master.name,
    location: master.location,
    email: master.email,
    phone: master.phone,
    links: master.links,
    summary: payload.summary.trim(),
    skills: asStringArray(payload.skills ?? [], "skills").slice(0, 14),
    roles,
    education: master.education,
    certifications: master.certifications,
  };

  const report: MatchReport = {
    target_title: (analysis.target_title || "Unknown").trim(),
    target_company: (analysis.target_company || "Unknown").trim(),
    matched_keywords: matched,
    missing_keywords: missing,
    notes: asStringArray(analysis.notes ?? [], "notes"),
    coverage: total === 0 ? 0 : Math.round((matched.length / total) * 100),
  };

  return { resume, report };
}

export async function tailorResume(
  master: MasterResume,
  jobDescription: string,
): Promise<{ resume: TailoredResume; report: MatchReport }> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new TailorError(
      "ANTHROPIC_API_KEY is not set. Add it to .env.local (local) or your Vercel project's environment variables.",
    );
  }

  const client = new Anthropic();
  const roleIds = master.roles.map((r) => r.id);

  // Streaming keeps the HTTP connection alive for the duration of the request,
  // which matters because thinking + a full rewrite can take tens of seconds.
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    output_config: {
      effort: EFFORT,
      format: { type: "json_schema", schema: buildSchema(roleIds) },
    },
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `<master_resume>\n${renderMaster(master)}\n</master_resume>`,
            cache_control: { type: "ephemeral" },
          },
          {
            type: "text",
            text: `<job_description>\n${jobDescription.trim()}\n</job_description>\n\nTailor the master resume to this job description.`,
          },
        ],
      },
    ],
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new TailorError(
      "Claude declined this request. If the job description contains unrelated or sensitive content, trim it to the role requirements and try again.",
    );
  }
  if (message.stop_reason === "max_tokens") {
    throw new TailorError(
      "The response was cut off before it finished. Try a shorter job description.",
    );
  }

  const text = message.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") {
    throw new TailorError("The model returned no text content.");
  }

  let payload: TailoredPayload;
  try {
    payload = JSON.parse(text.text) as TailoredPayload;
  } catch {
    throw new TailorError("The model returned output that was not valid JSON.");
  }

  return hydrate(master, payload);
}
