import type { MatchReport as Report } from "@/lib/types";

export function MatchReportPanel({ report }: { report: Report }) {
  return (
    <section className="rounded-lg border border-black/10 bg-white p-5 text-sm shadow-sm dark:border-white/10 dark:bg-white/5">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h2 className="font-semibold">Match report</h2>
          <p className="text-xs text-black/55 dark:text-white/55">
            {report.target_title}
            {report.target_company !== "Unknown"
              ? ` — ${report.target_company}`
              : ""}
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold tabular-nums">
            {report.coverage}%
          </div>
          <div className="text-[11px] text-black/50 dark:text-white/50">
            requirements covered
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <KeywordList
          title="Covered"
          items={report.matched_keywords}
          tone="good"
          empty="Nothing matched — check the job description pasted correctly."
        />
        <KeywordList
          title="Gaps"
          items={report.missing_keywords}
          tone="warn"
          empty="No stated requirement is unaddressed."
        />
      </div>

      {report.notes.length > 0 ? (
        <div className="mt-4 border-t border-black/10 pt-3 dark:border-white/10">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-black/55 dark:text-white/55">
            Before you apply
          </h3>
          <ul className="mt-2 space-y-1.5 text-[13px]">
            {report.notes.map((note, i) => (
              <li key={i} className="flex gap-2">
                <span aria-hidden className="text-black/35 dark:text-white/35">
                  →
                </span>
                <span>{note}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function KeywordList({
  title,
  items,
  tone,
  empty,
}: {
  title: string;
  items: string[];
  tone: "good" | "warn";
  empty: string;
}) {
  const chip =
    tone === "good"
      ? "bg-emerald-50 text-emerald-900 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-200 dark:ring-emerald-400/20"
      : "bg-amber-50 text-amber-900 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-100 dark:ring-amber-400/20";

  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-black/55 dark:text-white/55">
        {title} ({items.length})
      </h3>
      {items.length === 0 ? (
        <p className="mt-2 text-[13px] text-black/50 dark:text-white/50">{empty}</p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {items.map((item) => (
            <li
              key={item}
              className={`rounded px-2 py-0.5 text-[12px] ring-1 ring-inset ${chip}`}
            >
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
