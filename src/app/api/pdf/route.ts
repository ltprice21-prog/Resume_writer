import { NextResponse } from "next/server";
import { renderResumePdf } from "@/lib/pdf";
import type { TailoredResume } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

function isRenderable(value: unknown): value is TailoredResume {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<TailoredResume>;
  return (
    typeof r.name === "string" &&
    Array.isArray(r.roles) &&
    Array.isArray(r.education) &&
    Array.isArray(r.certifications)
  );
}

export async function POST(request: Request) {
  let body: { resume?: unknown; filename?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (!isRenderable(body.resume)) {
    return NextResponse.json(
      { error: "Request did not contain a renderable resume." },
      { status: 400 },
    );
  }

  const filename =
    typeof body.filename === "string" && /^[\w.-]+\.pdf$/.test(body.filename)
      ? body.filename
      : "resume.pdf";

  try {
    const pdf = await renderResumePdf(body.resume);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(pdf.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("pdf render failed", error);
    return NextResponse.json(
      { error: "Could not render the PDF." },
      { status: 500 },
    );
  }
}
