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
node portal/tests/*.test.js # 496 assertions across five files
```

| Source | Responsibility |
| --- | --- |
| `engine.js` | ZIP read/write, XLSX model, PDF text extraction, row planning, validation, `.eml` building |
| `templates.js` | Importing `.msg` / `.oft` / `.eml` / `.docx` / `.html` / `.txt`, CFB parsing, RTF decompression, placeholders |
| `workspace.js` | Divisions, accounts, items, users, templates, store interface, PO→item matching, recipient resolution |
| `status.js` | The five order stages, derivation from the tracker, the auto-close rule, account summaries |
| `charts.js` | Stat tiles, stacked bars, column charts, kanban pills — all inline SVG |
| `persist.js` | IndexedDB wrapper for the folder handle and session, permission queries, debounce |
| `app.js` / `app-teams.js` | The two UIs |
| `styles.css` | Salesforce-Lightning-style system, light and dark as deliberate palettes |

### Provenance tags

Field values: `pdf` · `computed` · `formula` · `carried` · `manual` · `edited`.
Order stages: `set` (a person chose it) · `auto` (the invoiced→closed rule) ·
`derived` (read from the tracker) · `none`.

### The five stages, in order

`placed` → `transit` → `delivered` → `invoiced` (open) → `closed` (terminal).

Invoiced deliberately precedes closed. `workspace.settings.autoCloseInvoiced`
defaults to true and closes **derived** invoiced orders only — an invoiced stage
a person set by hand always stands.

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

1. Whether Invoiced should count as open. It currently does; the auto-close rule
   makes this mostly moot.
2. Whether the tracker-derivation rules match how they actually read those
   columns.
3. What **Workspace → "What survives closing the app"** reports in their Chrome.
   That table was built to answer their "it does not save after closing" report,
   which was never reproducible here. The folder row reads either `remembered`
   or `not available here` plus the browser's own error text.
