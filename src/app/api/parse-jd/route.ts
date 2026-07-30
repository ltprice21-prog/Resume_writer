import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_BYTES = 8 * 1024 * 1024;

/** Extracts plain text from an uploaded job description (.txt, .md, .pdf, .docx). */
export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected a multipart upload." },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file was uploaded." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "That file is larger than 8 MB." },
      { status: 400 },
    );
  }

  const name = file.name.toLowerCase();
  const bytes = new Uint8Array(await file.arrayBuffer());

  try {
    let text: string;

    if (name.endsWith(".pdf")) {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const doc = await getDocumentProxy(bytes);
      const result = await extractText(doc, { mergePages: true });
      text = Array.isArray(result.text) ? result.text.join("\n") : result.text;
    } else if (name.endsWith(".docx")) {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({
        buffer: Buffer.from(bytes),
      });
      text = result.value;
    } else if (
      name.endsWith(".txt") ||
      name.endsWith(".md") ||
      name.endsWith(".rtf") ||
      file.type.startsWith("text/")
    ) {
      text = new TextDecoder().decode(bytes);
    } else {
      return NextResponse.json(
        {
          error:
            "Unsupported file type. Upload a .pdf, .docx, .txt or .md file — or just paste the text.",
        },
        { status: 400 },
      );
    }

    const cleaned = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

    if (cleaned.length < 40) {
      return NextResponse.json(
        {
          error:
            "Almost no text came out of that file. If it's a scanned image, copy the posting text and paste it instead.",
        },
        { status: 400 },
      );
    }

    return NextResponse.json({ text: cleaned });
  } catch (error) {
    console.error("parse-jd failed", error);
    return NextResponse.json(
      { error: "Could not read that file. Try pasting the text instead." },
      { status: 500 },
    );
  }
}
