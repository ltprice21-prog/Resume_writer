"use client";

import { useEffect, useState } from "react";
import { loadMaster, resetMaster, saveMaster } from "@/lib/storage";
import { MASTER_RESUME } from "@/lib/resume";
import type { MasterResume, Role } from "@/lib/types";

/**
 * Editing surface for the master resume. Changes are stored in this browser
 * only, and are sent with each tailoring request. "Reset" drops back to the
 * version checked into src/lib/resume.ts.
 */
export default function MasterPage() {
  const [master, setMaster] = useState<MasterResume>(MASTER_RESUME);
  const [saved, setSaved] = useState(false);

  useEffect(() => setMaster(loadMaster()), []);

  function update(patch: Partial<MasterResume>) {
    setMaster((m) => ({ ...m, ...patch }));
    setSaved(false);
  }

  function updateRole(id: string, patch: Partial<Role>) {
    update({
      roles: master.roles.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    });
  }

  function save() {
    saveMaster(master);
    setSaved(true);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Master resume</h1>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          The source of truth every tailored version is built from. Tailoring can
          reword and reorder what&apos;s here — it never adds employers, dates,
          metrics, or skills that aren&apos;t on this page. Saved in this browser
          only.
        </p>
      </div>

      <Card title="Contact">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Name"
            value={master.name}
            onChange={(v) => update({ name: v })}
          />
          <Field
            label="Location"
            value={master.location}
            onChange={(v) => update({ location: v })}
          />
          <Field
            label="Email"
            value={master.email}
            onChange={(v) => update({ email: v })}
          />
          <Field
            label="Phone"
            value={master.phone}
            onChange={(v) => update({ phone: v })}
          />
        </div>
      </Card>

      {master.roles.map((role) => (
        <Card key={role.id} title={role.company}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Title"
              value={role.title}
              onChange={(v) => updateRole(role.id, { title: v })}
            />
            <Field
              label="Company"
              value={role.company}
              onChange={(v) => updateRole(role.id, { company: v })}
            />
            <Field
              label="Location"
              value={role.location ?? ""}
              onChange={(v) => updateRole(role.id, { location: v })}
            />
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Start"
                value={role.start}
                onChange={(v) => updateRole(role.id, { start: v })}
              />
              <Field
                label="End"
                value={role.end}
                onChange={(v) => updateRole(role.id, { end: v })}
              />
            </div>
          </div>
          <TextArea
            label="Bullets (one per line)"
            value={role.bullets.join("\n")}
            rows={Math.max(4, role.bullets.length + 1)}
            onChange={(v) =>
              updateRole(role.id, {
                bullets: v.split("\n").map((b) => b.trim()).filter(Boolean),
              })
            }
          />
        </Card>
      ))}

      <Card title="Skills">
        <TextArea
          label="Evidenced skills (one per line) — the tailoring step selects from these"
          value={master.skills.join("\n")}
          rows={10}
          onChange={(v) =>
            update({
              skills: v.split("\n").map((s) => s.trim()).filter(Boolean),
            })
          }
        />
      </Card>

      <Card title="Certifications">
        <TextArea
          label="One per line"
          value={master.certifications.join("\n")}
          rows={4}
          onChange={(v) =>
            update({
              certifications: v.split("\n").map((c) => c.trim()).filter(Boolean),
            })
          }
        />
      </Card>

      <div className="sticky bottom-4 flex items-center gap-3 rounded-lg border border-black/10 bg-white/90 p-3 shadow-lg backdrop-blur dark:border-white/10 dark:bg-neutral-900/90">
        <button
          type="button"
          onClick={save}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-white/85"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => {
            resetMaster();
            setMaster(MASTER_RESUME);
            setSaved(false);
          }}
          className="rounded-md border border-black/15 px-3 py-2 text-sm hover:border-black/40 dark:border-white/15 dark:hover:border-white/40"
        >
          Reset to default
        </button>
        {saved ? (
          <span className="text-sm text-emerald-700 dark:text-emerald-400">
            Saved.
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border border-black/10 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-white/5">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-black/55 dark:text-white/55">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block text-sm">
      <span className="text-xs text-black/55 dark:text-white/55">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-black/15 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-black/40 dark:border-white/15 dark:bg-black/20 dark:focus:border-white/40"
      />
    </label>
  );
}

function TextArea({
  label,
  value,
  rows,
  onChange,
}: {
  label: string;
  value: string;
  rows: number;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block text-sm">
      <span className="text-xs text-black/55 dark:text-white/55">{label}</span>
      <textarea
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full resize-y rounded-md border border-black/15 bg-white p-2.5 text-[13px] leading-relaxed outline-none focus:border-black/40 dark:border-white/15 dark:bg-black/20 dark:focus:border-white/40"
      />
    </label>
  );
}
