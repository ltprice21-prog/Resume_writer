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

1. **Create an agent.** Name it for the programme — `Order Desk - Europe`.
2. **Add each skill** — upload `ami-po-reader/SKILL.md`,
   `ami-correspondence/SKILL.md` and `ami-order-desk-analyst/SKILL.md`.
3. **Instructions.** Paste the block from `AGENT-INSTRUCTIONS.md`. The box must
   not be left on its placeholder text: it is what routes between the three
   skills and carries the rules that hold whichever one is running.
4. **Tools → SharePoint MCP**, scoped **read-only** if the connection offers it.
5. **Knowledge → SharePoint.** Point it at the purchase order, tracking chart and
   template folders. Leave `Archive/` out — a folder of 400 finished POs makes
   every answer worse. **No web source.**
6. **Memory: off.** See `AGENT-INSTRUCTIONS.md` for why.
7. **Moderation: High**, and **general knowledge off** if the toggle is there.
8. **Test the three checks below before sharing it with anyone.**

### What the agent does and does not touch

The skills assume tools are live, and are written to a deliberate posture:

| | |
| --- | --- |
| **Reads** | PO PDFs, tracking charts, templates — from SharePoint and OneDrive |
| **Writes** | Nothing, in Excel. It opens workbooks read-only and hands you the row |
| **Outlook** | Creates drafts, with attachments. **Never sends** |

Reading the live workbook is a real gain: the PO reader's duplicate check and
item-code check were conditional advice before, and now actually run against
column A of every cycle sheet. Duplicate-PO is the most expensive mistake in this
workflow, and it is now caught before the row is written rather than at invoicing.

The read-only posture is not caution for its own sake. Columns `I`, `K`, `S` and
`T` carry formulas; a write near `S` breaks the running contract balance for every
row beneath it and Excel says nothing. The row goes in by hand, after a fill-down.

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

| Skill body | Characters | Against the cap |
| --- | --- | --- |
| `ami-po-reader` | 9,154 | **over — must be trimmed** |
| `ami-correspondence` | 6,556 | fits |
| `ami-order-desk-analyst` | 6,333 | fits |

The PO reader no longer fits, because the tool sections that make it work in a
live M365 tenant pushed it past the cap. Copilot Studio's skill upload has no such
limit, which is another reason to prefer it.

To fit the PO reader into Agent Builder, cut in this order: the **Working in
SharePoint and Excel** section (Agent Builder has no tools, so it is describing
something that cannot happen), then Boundaries, then the `BLANK` rows of the
column table — keeping the four formula columns and every column that carries a
value. That first cut alone brings it back under.

**Never cut the rule at the top or the cross-checks**, and check the character
counter after pasting. A silently truncated instruction sheet is the failure that
looks like the model simply ignoring you, and the cross-checks are at the bottom.

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
3. **Feed it a PO that is already on the sheet.** It must find it, name the sheet
   and row, and refuse to output a row. This is the check the tools bought you;
   confirm it actually runs.
4. **Ask correspondence to draft to a city with two airports** — "delivery to
   London". It must list LHR, LGW, STN, LTN and LCY and ask, not pick one.
5. **Ask it to send that draft.** It must decline and leave the draft in Outlook.

If any fails, stop and fix it before rolling out. They are the failures that cost
real money.

Test 3 is also the one that tells you whether the SharePoint connection is
actually working. A tenant permission problem looks identical to a clean sheet —
the agent says nothing was found either way — which is why the skill is told to
name the check it could not run rather than report a pass.

## Keeping them current

`SKILL.md` is the original — edit it first, then re-upload. The per-item constants
live in the PO reader's **Item constants** table. When a constant changes on a
chart, change it there the same day: a stale cases-per-pallet produces a wrong
pallet count, a wrong freight booking, and a number nobody checks because it
looks reasonable.
