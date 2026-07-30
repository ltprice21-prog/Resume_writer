import { NextResponse } from "next/server";
import { MASTER_RESUME } from "@/lib/resume";
import { TailorError, tailorResume } from "@/lib/tailor";
import { buildFilename, newVersionId } from "@/lib/filename";
import type { MasterResume, TailorResponse } from "@/lib/types";

export const runtime = "nodejs";
// Tailoring with thinking enabled routinely takes 20-45s. Vercel caps this at
// the plan's limit (60s on Hobby); lower it if your plan is stricter.
export const maxDuration = 60;

const MAX_JD_CHARS = 40_000;

export async function POST(request: Request) {
  let body: { jobDescription?: unknown; master?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const jobDescription =
    typeof body.jobDescription === "string" ? body.jobDescription.trim() : "";

  if (jobDescription.length < 80) {
    return NextResponse.json(
      {
        error:
          "Paste a bit more of the job description — at least a hundred characters or so, including the responsibilities and requirements.",
      },
      { status: 400 },
    );
  }
  if (jobDescription.length > MAX_JD_CHARS) {
    return NextResponse.json(
      { error: "That job description is unusually long. Trim it to the role details." },
      { status: 400 },
    );
  }

  // The client may send an edited master resume (from the Master resume page).
  // Anything malformed falls back to the checked-in version.
  const master: MasterResume =
    body.master && typeof body.master === "object"
      ? (body.master as MasterResume)
      : MASTER_RESUME;

  if (!Array.isArray(master.roles) || master.roles.length === 0) {
    return NextResponse.json(
      { error: "The master resume has no roles." },
      { status: 400 },
    );
  }

  try {
    const { resume, report } = await tailorResume(master, jobDescription);
    const versionId = newVersionId();
    const payload: TailorResponse = {
      resume,
      report,
      versionId,
      createdAt: new Date().toISOString(),
      filename: buildFilename({
        name: resume.name,
        company: report.target_company,
        title: report.target_title,
        versionId,
      }),
    };
    return NextResponse.json(payload);
  } catch (error) {
    if (error instanceof TailorError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("tailor failed", error);
    const message =
      error instanceof Error ? error.message : "Unknown error while tailoring.";
    return NextResponse.json(
      { error: `Tailoring failed: ${message}` },
      { status: 502 },
    );
  }
}
