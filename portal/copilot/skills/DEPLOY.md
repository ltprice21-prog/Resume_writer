# Deploying the AMI skills

Three `SKILL.md` files, each one an uploadable skill:

| Folder | Skill | What it does |
| --- | --- | --- |
| `ami-po-reader/` | `ami-po-reader` | Reads a PO PDF, gives you the tracker row |
| `ami-correspondence/` | `ami-correspondence` | Drafts vendor, trucker and customer emails from templates |
| `ami-order-desk-analyst/` | `ami-order-desk-analyst` | Answers questions about the tracking charts |

Each is self-contained — frontmatter plus body, no companion files. Upload the
`SKILL.md` itself. `build-skills.sh` wraps each one as a `.zip` if your tenant
insists on an archive, but since every skill is a single file, the zip carries
nothing the `.md` does not.

**Correction to what this file used to say.** An earlier version of this document
claimed no Microsoft product ingests `SKILL.md` directly, and told you to paste
the body into an instruction box. Copilot Studio now accepts skill upload —
`SKILL.md`, or a `.zip` containing one, with `name` and `description` in YAML
frontmatter. Upload is the better route and the instructions below use it.

---

## Copilot Studio — the recommended setup

**One agent, three skills.** That is what skill upload is for: the agent picks
the skill by matching the request against each `description`, and your team has
one place to go rather than three.

1. **Create an agent.** Name it `AMI Order Desk`. Description: *"Reads AMI
   purchase orders, drafts order correspondence, and answers questions about the
   order tracking charts."*
2. **Add each skill** — upload `ami-po-reader/SKILL.md`,
   `ami-correspondence/SKILL.md` and `ami-order-desk-analyst/SKILL.md`.
3. **Knowledge → SharePoint.** Point it at the `AMI Order Desk` library: the
   purchase order, tracking chart and template folders. Leave `Archive/` out — a
   folder of 400 finished POs makes every answer worse.
4. **Moderation: High.** This tightens how far the model goes beyond its sources,
   which is the behaviour all three skills are built around.
5. **General knowledge: off**, if the toggle is available. Nothing outside your
   documents should reach a tracker row.
6. **Test the three checks below before sharing it with anyone.**

### When to split into three agents instead

Split if the analyst starts answering chart questions out of a PO PDF, or the PO
reader starts quoting the tracking chart back at you. That is a knowledge-scoping
problem, and the fix is one agent per skill with only its own folder attached:

| Agent | Skill | Knowledge |
| --- | --- | --- |
| `AMI PO Reader` | `ami-po-reader` | `Purchase orders/` |
| `AMI Correspondence` | `ami-correspondence` | `Templates/`, `Purchase orders/` |
| `AMI Order Desk Analyst` | `ami-order-desk-analyst` | `Tracking charts/` |

Start with one. Split only if you see the symptom.

### On running Opus

Opus follows a long constraint sheet more faithfully than a smaller model, which
is exactly what these skills are — the value is in the rules the model declines
to break. Keep the model setting where it is for the PO reader and the analyst.
Correspondence would survive a smaller model; the other two are where a
plausible-looking invented number costs money.

## Microsoft 365 Copilot — Agent Builder

Agent Builder has no skill upload. Paste the body of each `SKILL.md` — everything
below the closing `---` — into **Configure → Instructions** (not Describe, which
rewrites what you paste). One agent per skill, knowledge per the split table
above, **Web search off**.

The instructions field caps at **8,000 characters**. Measured:

| Skill body | Characters |
| --- | --- |
| `ami-po-reader` | 7,556 |
| `ami-order-desk-analyst` | 5,557 |
| `ami-correspondence` | 5,114 |

All three fit. The PO reader has about 440 characters of headroom, so if you add
items to its constants table, watch the counter. **A silently truncated
instruction sheet is the failure that looks like the model ignoring you**, and it
is the cross-checks at the bottom that get cut first.

If you must trim, cut the Boundaries section, then the `BLANK` rows of the column
table — keeping the four formula columns and every column that carries a value.
**Never cut the rule at the top or the cross-checks.**

## Claude

Drop the folders into `.claude/skills/`. They load as-is.

---

## What the skills deliberately do not do

**Write to the tracking chart.** Columns `I`, `K`, `S` and `T` carry formulas.
An automated write to `S` breaks the running contract balance for every row
beneath it, and nothing in Excel warns you. All three skills are written for
read-and-report: the agent produces a row, a person fills down from the row above
and types the values in.

If you later add a Power Automate action that writes to the workbook, that action
must fill down from the previous row first, then set only the value columns **by
heading name, never by index**, and never touch `I`, `K`, `S` or `T`. Add the
constraint before you enable the action, not after the first corrupted sheet.

**Totals.** Copilot reads a spreadsheet as text and will miscount across many
rows. The analyst skill says so itself, every time it counts. Exact figures come
from `../excel-dashboard.md` — a sheet of formulas per workbook, half an hour
once, and then the numbers recalculate themselves. Build that before you rely on
any number for a booking.

## The three tests that matter

Run these on day one, against a PO you have already posted by hand:

1. **Give the PO reader a PO and compare every cell** to the row you posted.
   Anything that differs is either a real find or a fabrication — you want to know
   which on day one, not in month two.
2. **Ask it for a field the PO does not carry** — a bottling date. It must answer
   `BLANK` and list it. A date here means the instructions are not taking.
3. **Ask correspondence to draft to a city with two airports** — "delivery to
   London". It must list the options and ask, not pick one.

If any of the three fails, stop and fix it before rolling out. They are the three
failures that cost real money.

## Keeping them current

`SKILL.md` is the original — edit it first, then re-upload. The per-item constants
live in the PO reader's **Item constants** table. When a constant changes on a
chart, change it there the same day: a stale cases-per-pallet produces a wrong
pallet count, a wrong freight booking, and a number nobody checks because it
looks reasonable.
