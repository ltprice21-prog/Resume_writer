# Handoff — AMI Order Desk

Read this first if you are picking the project up in a fresh session. It is the
shortest complete description of what exists, what must not change, and where
the code lives.

Branch: `claude/workflow-automation-portal-afsdjt`
Repository: `ltprice21-prog/Resume_writer`

---

## What this is

A workflow tool for AMI Group (wine logistics for airlines). It reads purchase
order PDFs, appends the rows to an existing Excel order tracker, and drafts the
emails that follow — with no server, no install, and no AI service.

Two deliverables, both single self-contained HTML files opened from disk:

| File | Who it is for |
| --- | --- |
| `AMI-Order-Desk.html` | One person, one tracker. Frozen at the customer's request — build it, but do not add features. |
| `AMI-Order-Desk-Teams.html` | The live product. Divisions, accounts, multiple item trackers per account, shared templates, order statuses, Account Health dashboard. |

## Constraints that are not negotiable

1. **Never fabricate.** Every value shown or written traces to an uploaded PDF,
   the tracker's own formula, or a person typing it. Provenance is a first-class
   part of the data model, not a presentation detail — see the `source` tags
   below. If a value cannot be sourced, leave it blank and say so.
2. **No API calls, ever.** Extraction is deterministic: PDF content streams are
   inflated in the browser and text read by position, anchored to the labels NAV
   prints. There is no model call anywhere in the product and there must not be.
3. **No installs.** The customer cannot install software. Everything runs from
   `file://` in Edge or Chrome using the File System Access API.
4. **Never break the tracker.** The sheet uses shared formulas. Appending static
   values silently breaks it; the writer continues the formulas instead.

## Architecture

`portal/src/*` are the sources. `portal/*.html` are **generated** — always edit
the sources and rebuild, never the HTML.

```
node portal/build.js        # inlines src/* into both HTML files
node portal/tests/*.test.js # 678 assertions across five files
```

| Source | Responsibility |
| --- | --- |
| `engine.js` | ZIP read/write, XLSX model, PDF text extraction, row planning, validation, follow-up rules, `.eml` building |
| `templates.js` | Importing `.msg` / `.oft` / `.eml` / `.docx` / `.html` / `.txt`, CFB parsing, RTF decompression, placeholders, internal-note stripping |
| `airports.js` | Airport table and address lookup, with a hard refusal to pick between a city's airports |
| `workspace.js` | Divisions, accounts, items, users, templates, standing attachments, store interface, PO→item matching, recipient resolution |
| `status.js` | The four order stages, derivation from the tracker, contract standing, the schedule, account summaries |
| `charts.js` | Stat tiles, stacked bars, column charts, stage fills — all inline SVG |
| `persist.js` | IndexedDB wrapper for the folder handle and session, permission queries, debounce |
| `app.js` / `app-teams.js` | The two UIs |
| `styles.css` | Salesforce-Lightning-style system, light and dark as deliberate palettes |

### Provenance tags

Field values: `pdf` · `computed` · `formula` · `carried` · `manual` · `edited`.
Order stages: `set` (a person chose it) · `derived` (read from the tracker) ·
`none` (nothing to go on — never guessed).

### The four stages, in order

`placed` → `transit` → `delivered` → `invoiced` (terminal, labelled "Invoiced and
Closed").

Invoicing ends the order; there is no separate closed stage and no rule that
moves orders between the two. `LEGACY_STATUS_IDS` maps a stored `closed` onto
`invoiced` so records written before the merge keep meaning what they meant, and
`canonicalStatusId` is the only place that mapping lives.

Each stage also declares a `pattern` — solid, diagonal, horizontal, vertical —
which is the **primary** signal, not decoration. The customer is colourblind and
four stages sit on one hue, so hue never works alone: `stageClass(step)` paints
both, `statusLegend` names the weave in words, and anything measuring something
other than pipeline position (an age, a count) takes the reserved status palette
via `tone` instead of a stage weave.

### Contract standing and the schedule

`contractStanding(orders, ctx)` reads the balance off the **last order row** — the tracker
carries a running total that steps down per order, so nothing is recomputed. Below
zero is `over`, exactly zero is `closed`, above zero is `open`. Their 2025 sheet
really does go to −10,176 bt, so the negative case is not hypothetical; never
clamp it.

`scheduleFlags(order, today)` splits lateness two ways and the distinction is the
whole point:

- `collectionOverdue` / `deliveryOverdue` — the date passed and the tracker still
  records nothing. Chaseable today. **These, and only these, set account health.**
- `collectedLate` / `deliveredLate` — it happened, just after the date asked for.
  Counted and displayed, but never moves the health mark.

Without that split every account sits permanently at risk: on the sample tracker
most historical orders ran one to five days late, which is unchaseable history,
not workload. If someone asks why an account with late deliveries reads "on
track", that is the answer.

`groupSchedule(entries, 'week'|'month', today)` buckets what is outstanding, with
overdue as its own leading group rather than filed under the week it was due.

### Follow-ups stop when the workflow overtakes them

Each rule in `FOLLOW_UP_RULES` declares `supersededBy` — the columns whose
presence makes the chase pointless. `findOpenItems` marks those items
`superseded` with the evidence rather than dropping them; the interface files
them under "No longer needed" and excludes them from every count. Do not change
this to hide them: a blank column on a shipped order is still a gap in the
record, and that was a deliberate call.

### Templates never invent a value

`auditPlaceholders` reports every placeholder a template uses, its value and its
provenance — `filled`, `derived`, `typed in`, `missing`. A gap gets a box to type
into, stored in `state.emailOverrides.vars` and applying to that draft only.

Airport codes follow the same rule. `airportForAddress` prefers a code already
printed on the PO, falls back to matching the airport's name and then the city,
and **returns nothing with a list of `choices` when a city has several airports**.
Never add a tie-break: sending wine to Gatwick because the address said "London"
is the exact failure that table exists to prevent.

### Attachments

Three sources, kept distinct: the PO PDFs in hand, standing files on the item
under `attachments/<account>/<item>/` in the shared folder, and per-draft files
held in `state.draftAttachments` and never written anywhere. A missing standing
file blocks the draft with its name rather than sending one short.

### Persistence

Unposted work is written to `order-desk-sessions/<userId>.json` **in the shared
folder**, not browser storage, so it survives any browser and follows the user
to another machine. The IndexedDB copy is a fast path, not the source of truth.
The only thing that genuinely requires local storage is the folder handle, which
saves a trip through the picker. Workspace bundles exclude `order-desk-sessions/`
so exporting configuration never carries someone's half-finished batch.

## Things already learned the hard way

- `DecompressionStream` rejects the padding PDFs leave past `/Length`.
  `inflateTolerant` tries declared length, then trimmed, then raw.
- `valueRightOf` must stop at the next item ending in `:`, or labels swallow the
  following field.
- `blockUnder` must stop when the column runs empty, or the ship-to address eats
  the line-item table.
- Editing a PO number has to flow through `planPoNumber(plan, po)`, otherwise
  duplicate detection reads the stale one.
- `[hidden]` needs `!important`; the flex rules outrank the UA default.
- The customer's Outlook stores compressed RTF, not HTML — templates come out of
  `.msg` via LZFu decompression and de-encapsulation.
- Their tracker contains three real data errors (PO 319844-2 delivery serial
  415006; rows 41/42 mistyped required-delivery serials). `plausibleWindow` and
  `dateIssues` surface these rather than silently propagating them.

## Test fixtures

Not committed — they are customer data. Tests read from
`/root/.claude/uploads/<session>` by default; point them at wherever the PO PDF,
tracker, and vendor email actually are.

## Open questions for the customer

1. Whether the tracker-derivation rules match how they actually read those
   columns.
2. What **Workspace → "What survives closing the app"** reports in their Chrome.
   That table was built to answer their "it does not save after closing" report,
   which was never reproducible here. The folder row reads either `remembered`
   or `not available here` plus the browser's own error text.
