import type { TailoredResume } from "@/lib/types";

/** On-screen mirror of the PDF layout, so what you see is what downloads. */
export function ResumePreview({ resume }: { resume: TailoredResume }) {
  return (
    <article className="rounded-lg border border-black/10 bg-white p-8 text-[13px] leading-relaxed text-neutral-900 shadow-sm dark:border-white/10">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">{resume.name}</h1>
        <p className="mt-1 text-xs text-neutral-600">
          {[resume.location, resume.email, resume.phone].filter(Boolean).join("  •  ")}
        </p>
        {resume.links.map((link) => (
          <a
            key={link.url}
            href={link.url}
            target="_blank"
            rel="noreferrer"
            className="block text-xs text-neutral-600 underline-offset-2 hover:underline"
          >
            {link.label}
          </a>
        ))}
      </header>

      <hr className="my-4 border-neutral-900" />

      {resume.summary ? (
        <Section title="Summary">
          <p>{resume.summary}</p>
        </Section>
      ) : null}

      {resume.skills.length > 0 ? (
        <Section title="Core Skills">
          <p>{resume.skills.join(", ")}</p>
        </Section>
      ) : null}

      <Section title="Experience">
        {resume.roles.map((role) => (
          <div key={role.id} className="mb-4 last:mb-0">
            <div className="flex items-baseline justify-between gap-4">
              <h3 className="font-bold">{role.title}</h3>
              <span className="shrink-0 text-xs text-neutral-600">
                {role.start} – {role.end}
              </span>
            </div>
            <p className="text-xs text-neutral-600">
              {[role.company, role.location].filter(Boolean).join("  |  ")}
            </p>
            <ul className="mt-1.5 space-y-1">
              {role.bullets.map((bullet, i) => (
                <li key={i} className="flex gap-2">
                  <span aria-hidden>•</span>
                  <span>{bullet}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </Section>

      <Section title="Education">
        {resume.education.map((entry) => (
          <p key={entry.degree} className="mb-1">
            <span className="font-bold">{entry.degree}</span>
            {`  |  ${[entry.school, entry.detail].filter(Boolean).join("  |  ")}`}
          </p>
        ))}
      </Section>

      {resume.certifications.length > 0 ? (
        <Section title="Certifications and Licenses">
          <ul className="space-y-1">
            {resume.certifications.map((cert) => (
              <li key={cert} className="flex gap-2">
                <span aria-hidden>•</span>
                <span>{cert}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </article>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-5 last:mb-0">
      <h2 className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em]">
        {title}
      </h2>
      {children}
    </section>
  );
}
