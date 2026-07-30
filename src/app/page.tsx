"use client";

import { useEffect, useRef, useState } from "react";
import { ResumePreview } from "@/components/ResumePreview";
import { MatchReportPanel } from "@/components/MatchReport";
import {
  addToHistory,
  clearHistory,
  loadHistory,
  loadMaster,
  type HistoryEntry,
} from "@/lib/storage";
import type { TailorResponse } from "@/lib/types";

export default function TailorPage() {
  const [jobDescription, setJobDescription] = useState("");
  const [result, setResult] = useState<TailorResponse | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [status, setStatus] = useState<"idle" | "reading" | "tailoring">("idle");
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => setHistory(loadHistory()), []);

  async function handleFile(file: File) {
    setError(null);
    setStatus("reading");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/parse-jd", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not read that file.");
      setJobDescription(data.text);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that file.");
    } finally {
      setStatus("idle");
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function handleTailor() {
    setError(null);
    setStatus("tailoring");
    try {
      const res = await fetch("/api/tailor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobDescription, master: loadMaster() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Tailoring failed.");

      const payload = data as TailorResponse;
      setResult(payload);
      setHistory(
        addToHistory({
          ...payload,
          jobDescriptionPreview: jobDescription.slice(0, 160),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Tailoring failed.");
    } finally {
      setStatus("idle");
    }
  }

  async function download(entry: TailorResponse) {
    setDownloading(true);
    setError(null);
    try {
      const res = await fetch("/api/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resume: entry.resume, filename: entry.filename }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Could not build the PDF.");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = entry.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not build the PDF.");
    } finally {
      setDownloading(false);
    }
  }

  const busy = status !== "idle";

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Tailor your resume
          </h1>
          <p className="mt-1 text-sm text-black/60 dark:text-white/60">
            Paste or upload a job description. Every generation produces its own
            PDF, named for the role and dated, so nothing overwrites anything.
          </p>
        </div>

        <div className="rounded-lg border border-black/10 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-white/5">
          <label
            htmlFor="jd"
            className="text-xs font-semibold uppercase tracking-wide text-black/55 dark:text-white/55"
          >
            Job description
          </label>
          <textarea
            id="jd"
            value={jobDescription}
            onChange={(e) => setJobDescription(e.target.value)}
            placeholder="Paste the full posting — title, company, responsibilities and requirements."
            rows={16}
            className="mt-2 w-full resize-y rounded-md border border-black/15 bg-white p-3 font-mono text-[12px] leading-relaxed outline-none focus:border-black/40 dark:border-white/15 dark:bg-black/20 dark:focus:border-white/40"
          />

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleTailor}
              disabled={busy || jobDescription.trim().length < 80}
              className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-neutral-900 dark:hover:bg-white/85"
            >
              {status === "tailoring" ? "Tailoring…" : "Tailor resume"}
            </button>

            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={busy}
              className="rounded-md border border-black/15 px-3 py-2 text-sm transition hover:border-black/40 disabled:opacity-40 dark:border-white/15 dark:hover:border-white/40"
            >
              {status === "reading" ? "Reading…" : "Upload file"}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".txt,.md,.pdf,.docx,text/plain,application/pdf"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />

            {jobDescription ? (
              <button
                type="button"
                onClick={() => setJobDescription("")}
                disabled={busy}
                className="text-sm text-black/50 underline-offset-2 hover:underline disabled:opacity-40 dark:text-white/50"
              >
                Clear
              </button>
            ) : null}
          </div>

          {status === "tailoring" ? (
            <p className="mt-3 text-xs text-black/50 dark:text-white/50">
              Claude is rewriting your bullets against this posting. This usually
              takes 20–45 seconds.
            </p>
          ) : null}
        </div>

        {error ? (
          <p
            role="alert"
            className="rounded-md border border-red-600/25 bg-red-50 px-3 py-2 text-sm text-red-900 dark:bg-red-500/10 dark:text-red-200"
          >
            {error}
          </p>
        ) : null}

        {history.length > 0 ? (
          <section className="rounded-lg border border-black/10 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-white/5">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-black/55 dark:text-white/55">
                Previous versions
              </h2>
              <button
                type="button"
                onClick={() => setHistory(clearHistory())}
                className="text-xs text-black/45 underline-offset-2 hover:underline dark:text-white/45"
              >
                Clear
              </button>
            </div>
            <ul className="mt-3 space-y-2">
              {history.map((entry) => (
                <li
                  key={entry.versionId}
                  className="flex items-center justify-between gap-3 rounded-md border border-black/10 px-3 py-2 dark:border-white/10"
                >
                  <button
                    type="button"
                    onClick={() => setResult(entry)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block truncate text-[13px] font-medium">
                      {entry.report.target_title}
                      {entry.report.target_company !== "Unknown"
                        ? ` — ${entry.report.target_company}`
                        : ""}
                    </span>
                    <span className="block text-[11px] text-black/45 dark:text-white/45">
                      {new Date(entry.createdAt).toLocaleString()} ·{" "}
                      {entry.report.coverage}% covered
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void download(entry)}
                    disabled={downloading}
                    className="shrink-0 text-xs underline underline-offset-2 disabled:opacity-40"
                  >
                    PDF
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <div className="space-y-5">
        {result ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 truncate font-mono text-xs text-black/50 dark:text-white/50">
                {result.filename}
              </p>
              <button
                type="button"
                onClick={() => void download(result)}
                disabled={downloading}
                className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40 dark:bg-white dark:text-neutral-900 dark:hover:bg-white/85"
              >
                {downloading ? "Building PDF…" : "Download PDF"}
              </button>
            </div>
            <MatchReportPanel report={result.report} />
            <ResumePreview resume={result.resume} />
          </>
        ) : (
          <div className="flex h-full min-h-[320px] items-center justify-center rounded-lg border border-dashed border-black/15 p-8 text-center text-sm text-black/45 dark:border-white/15 dark:text-white/45">
            Your tailored resume will appear here.
          </div>
        )}
      </div>
    </div>
  );
}
