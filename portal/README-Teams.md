# AMI Order Desk — Teams edition

`AMI-Order-Desk-Teams.html` is the multi-account version of the portal. Same engine, same
guarantees; adds an Account Health dashboard, divisions, per-user account lists, several item
trackers per account, and templates that live with the account instead of in one person's
browser.

The single-account version (`AMI-Order-Desk.html`) is unchanged and still works on its own.

---

## How the sharing works

There is no server and no sign-in. Everything shared lives as ordinary files in **one folder**:

```
AMI Order Desk/                       <- a SharePoint library, synced through OneDrive
  AMI-Order-Desk-Teams.html           the app
  workspace.json                      divisions, accounts, items, people, contacts, rules
  order-status.json                   the stage each order is at
  order-desk-sessions/                unposted work, one file per person
  templates/
    aeromexico/
      vendor-order.html               a template, with a small JSON header
      trucker-booking.html
    delta/
      customer-update.html
  trackers/
    Aeromexico - Evidencia Tempranillo.xlsx
    Aeromexico - Montenero.xlsx
    Delta - Reserva.xlsx
```

Sync that library through OneDrive and it appears as a normal Windows folder. Everyone opens
the same `.html` from it, points the app at the folder once, and OneDrive distributes every
change — a new template, a corrected contact, a posted order — to the rest of the team.

**Setup, once:** in SharePoint, open the document library and click **Sync**. Then open the
HTML file from the synced folder, click **Open the workspace folder**, and pick it. Edge asks
for permission the first time; that is the only prompt.

### Why not connect to SharePoint directly

An HTML file opened from disk cannot sign in to SharePoint Online. That requires an Azure AD
app registration, admin consent, and the page to be served from a registered redirect URI —
in other words, IT involvement and a hosted deployment.

The synced folder reaches the same files with none of that. If you later want the direct
connection, what IT would need to provide is: an app registration with delegated
`Files.ReadWrite.All` and `Sites.ReadWrite.All`, admin consent, and somewhere to host the
page. The file layout above would not change; only how it is read.

---

## Divisions, accounts, items and people

- **Divisions** — Europe and US by default; add or rename any.
- **Accounts** — one per customer (Aeromexico, Delta, British Airways).
- **Items** — one per tracking chart. An account has as many as it runs: Aeromexico might
  carry Evidencia Tempranillo, Montenero and a white, each with its own workbook, sheet,
  contract balance and vendor.
- **People** — each has a division and, optionally, a list of accounts.

### Adding item trackers

**Accounts → Edit an account → Item trackers → Add item tracker.** Name it, then open
**Assign a tracker**.

The dialog lists every spreadsheet in the folder and says which item already uses each one, so
two items cannot quietly share a sheet. Choosing a workbook reads it and offers its real sheet
names with the order count on each — a workbook laid out by year gives you the year. *Automatic*
takes the last sheet carrying a `PO#` header, which is usually the current cycle, and the dialog
names the sheet that would be.

### Correcting a tracker assignment

The same dialog reopens from anywhere the mistake shows: **Change workbook or sheet** in the item
editor, the **Tracker** button on the item row in Workspace, and **Change tracker** on the warning
when a workbook cannot be read.

Reassigning moves nothing. Rows already posted stay in the workbook and sheet they went into —
only the next post and the dashboard reading change. The dialog says so before you save.

Each item can override the account's contacts. A second product from a different winery gets
its own vendor address; anything left blank falls back to the account. Every draft says which
of the two it used.

### Purchase orders find their own tracker

Drop a batch of POs — they do not have to be for the same item. Each is matched to an item by
the item number printed on it, checked against the NAV code in each item's tracker, so the
routing comes from the workbooks rather than anything typed twice.

Each PO card shows the item it matched and why, with a dropdown to correct it. A PO that
matches nothing, or matches two items, is **left unassigned and cannot be posted** — it is
never quietly filed under the first item.

Review groups the orders by item, naming the workbook each will reach, and posts per item
with its own backup. One button posts them all when a batch spans several trackers.

Emails are drafted per item, since the breakdown table is per product. Follow-ups go the
other way and scan every item on the account at once, with an Item column, so nothing hides
behind the switcher.

Visibility follows one rule: assign someone specific accounts and they see exactly those;
leave the list empty and they see every account in their division; mark them an administrator
and they see everything and can edit the shared setup.

> **This organises the view. It does not lock anything.**
> Anyone who can open the shared folder can open any tracker in it. If some accounts must be
> genuinely restricted, put them in separate SharePoint folders and set permissions there —
> that is the only place they can be enforced. The app is honest about this on screen.

Your choice of name is remembered in your browser; nothing else is stored locally.

---

## Account Health

The landing page. It reads every item tracker across the accounts you can see, and answers four
questions in order, each its own section:

**Headline figures** first — open orders, collections and deliveries past their date, items
closed, contracts over-drawn, follow-ups outstanding, and the next date due.

### 1 · Contracts

One row per item tracker: the contract balance in bottles and cases, whether the contract is
open, closed or over-drawn, the most recent delivery actually recorded, and the furthest-out
delivery date anyone has asked for — each dated figure attributed to its PO.

**The balance is the tracker's own running total** after the last order on the sheet, not a
figure worked out here. Their sheets carry a balance that steps down with each order, so the
last row is what is left.

| Balance | Reads as |
| --- | --- |
| Above zero | **Open** — quantity left to order |
| Exactly zero | **Closed** — everything contracted has been ordered |
| Below zero | **Over contract** — flagged in red, at the top of the card |

A negative balance is shown as negative. It is a real state their sheets get into, and rounding
it up to zero would hide it.

**Items closed** is counted against the cycle — the sheet an item posts into. A workbook laid out
by year has one sheet per cycle, so "0 of 2 on 2026 Cycle" means what it says.

### 2 · What is coming

Every requested collection date with nothing collected yet, and every required delivery date with
nothing delivered yet, **grouped by week or by month**. A date that has been met drops off — it
needs nothing.

**Overdue is its own group at the top**, not filed under the week it was due. Burying a missed
date in a past week is how it stays missed.

### 3 · Pipeline

Where the orders themselves stand: the stacked pipeline, orders by account, cases collected per
month, and the kanban board.

### 4 · Needs attention

**Dates that have passed** — two lists, not collected and not delivered, each with how many days
past. This is what sets account health.

Then **longest without movement** (the eight open orders that have sat still longest) and the
**account health** table.

Filter by **division**, **account** and **item**. The division list only offers divisions you
actually have accounts in, so the filter can never show you an empty world by accident.

### Looking closer

**Expand** on any chart opens it large — and unabridged, so *Longest without movement* shows
every open order rather than the top eight.

**Click any bar, band or column** to list the orders behind it: PO, account, item, cases, stage,
where the stage came from, and the last dated activity. Every column is read from the tracker or
from a status someone set — nothing in the drill-down is calculated for the chart. The **Orders**
button on each account-health row does the same for a whole account.

Escape, the backdrop or **Close** dismisses it.

### The four stages

`Order placed – awaiting shipment` → `In transit` → `Delivered` → `Invoiced and Closed`

**Invoicing ends the order.** There is no separate closed stage and no rule that moves orders
between the two, because the two were never different here — a NAV invoice number on the tracker
puts an order at the last stage on its own, and everything short of that counts as open.

A status recorded as *Closed* before the stages merged still reads correctly; it resolves onto
the merged stage and says so, so old records keep meaning what they meant.

### Hiding what is finished

**Hide invoiced and closed**, on both Account Health and Order status, leaves the finished
orders out of the view. Counts, bars and the board all follow the switch — it changes what you
are looking at, not what is true. The choice is per person and is remembered.

Set them on the **Order status** page — a table with a dropdown per order, a bulk "set selected
to…", and filters including *Open only* and *No status set*. Anything you set there is what the
dashboard shows.

### Where a status comes from

Every order's stage is one of two things, and the interface always says which:

| | |
| --- | --- |
| **Set by a person** | Chosen on the Order status page or by dragging a kanban card. Records who and when. |
| **From the tracker** | Read from the dated columns already in the workbook — a NAV invoice number means *Invoiced*, a delivery date means *Delivered*, a collection date means *In transit*, a PO sent to the winery means *Awaiting shipment*. |

The tracker can carry an order as far as *Invoiced*. *Closed* has no column behind it, so it
only ever comes from a person — which is the point: closing is a decision, not a side effect.

Nothing is guessed. An order with neither reads **Not set** rather than being filed under a
stage nobody chose.

A status you set always wins over what the tracker implies, and clearing it falls back to the
tracker again.

Statuses live in `order-status.json` beside the trackers, so the whole team sees the same board.
Two people editing different orders both survive: the file merges entry by entry, newest wins
per order, rather than one save overwriting the other's work.

### Health, stated plainly

Health reads **two things and nothing else**: orders whose requested collection date has passed
with no collection recorded, and orders whose required delivery date has passed with no delivery
recorded.

| | |
| --- | --- |
| **At risk** | Any required delivery date passed unmet, or a collection more than 14 days past. |
| **Needs attention** | Any requested collection date passed unmet. |
| **On track** | Every collection and delivery date so far has been met or is still ahead. |

A missed delivery outranks a missed collection, because a missed delivery is the customer's
problem.

**Orders that were collected or delivered late are counted separately, and do not move the
health mark.** They appear in a *Met late* column as a record of how the account has actually
run. This split matters: on the sample tracker most historical orders ran one to five days late,
so counting them as risk would leave every account permanently red over something nobody can
chase. Health is about what needs doing today.

There is no score and no weighting to reverse-engineer; the threshold is one edit in
`HEALTH_THRESHOLDS`, and the reasons are printed next to every verdict.

### Dates the tracker cannot mean

While reading the trackers the dashboard checks every date it finds. A mistyped serial — the
sample chart has a delivery date reading **30 March 3036** — would otherwise dominate every
age and ranking it touches. Those rows are listed at the top of the dashboard with the PO, the
column and the raw value, and excluded from the ages below until you fix the workbook.

### Account summary

**Generate account summary** produces a document of the account's open orders: totals by stage,
then a row per order with its stage, where that stage came from, the last dated activity and how
long ago. Copy it, download it as HTML, or send it as an Outlook draft addressed from the
account's customer contact. Every column is read from the tracker or the stored status — there
is no narrative text beyond the headings.

---

## What survives closing the app

The Workspace page shows a table of exactly this, live, for the browser you are actually in.

**Everything shared** — statuses, templates, workspace configuration, tracker rows — is written
to the shared folder the moment you change it. Never waiting on a save, in any browser.

**Unposted purchase orders**, with their item routing and edits, are written to
`order-desk-sessions/<your-name>.json` in the same folder. That needs no browser storage at
all, so it works everywhere and even follows you to another machine. Reopen and the Orders tab
offers them back: *Restore them* or *Discard*. Restored PDFs are re-read from scratch, so they
go through exactly the same extraction and validation as one dropped in fresh — a restored
order is never trusted more than a new one. Posting clears what it wrote.

**The folder itself, and who you are** are kept in the browser's local storage, purely so you
do not have to find the folder again. This is the only part that depends on the browser, and
some configurations block it. When that happens the Workspace page says so, quotes the reason
the browser gave, and everything else carries on — you just pick the folder each time.

> Browsers do not, by default, keep file-access permission across a restart. Reconnecting is
> therefore one click on *Reconnect to <folder>*, not a trip through the picker. If even that
> does not appear, the Workspace table will show *not available here* against the folder row,
> with the browser's own explanation.

**Closing with unposted orders is challenged** — the browser asks whether you really mean to
leave. Saved is not the same as posted.

### Changing the source folder

**Workspace → Change source folder** points the app somewhere else if you picked the wrong one.
Unposted work stays in the old folder, and is offered back if you return to it; the app warns
before switching if you have any. In bundle mode the same button loads a different bundle.

The single-account build remembers its tracker the same way.

---

## Follow-ups

Every item tracker on the account is scanned for a column that should have been filled by now,
measured from a dated column and a grace period. Each line names the blank column and the dated
column it is measured from — nothing is inferred.

### Chases the workflow has overtaken

**A chase stops being worth sending once the order has moved past it.** If a winery never
confirmed an available date but the goods were collected three weeks ago, asking now changes
nothing. Each rule declares which columns overtake it: a delivery date closes out the collection
chase, an invoice number closes out the rest.

Overtaken items move to a collapsed **No longer needed** list with the evidence that overtook
them — *"still blank, but NAV INV # is recorded — the order moved on without it"*. They are not
counted as outstanding work and no email is drafted for them.

They are **not hidden**, because a blank column on a shipped order is still a gap in the record,
and a tidier list would be a less honest one.

## Templates

Upload what you already send. The app reads:

| Format | Notes |
| --- | --- |
| `.msg`, `.oft` | Outlook messages and templates. Formatting, tables and lists are preserved. |
| `.docx` | Word. Headings, bold, italic, lists and tables come across. |
| `.eml` | Exported messages, including quoted-printable and base64 bodies. |
| `.html`, `.txt` | Taken as-is; a leading `Subject:` line becomes the subject. |

Outlook stores many messages as compressed RTF rather than HTML. The app decompresses it and
recovers the original HTML, so an imported template looks like the message you sent — not a
plain-text approximation of it.

Each template is tagged with who it goes to — **vendor / winery**, **trucker / forwarder**,
**customer / airline**, **internal** — and with what it applies to: every item on the account,
or one item only. The Emails tab shows templates for the counterparty you picked, item-specific
ones first, then account-wide.

### Placeholders

Anything in double braces is filled from the PO, the tracker and the account record:

| | |
| --- | --- |
| **Order** | `{{poCount}}` `{{poGroups}}` `{{poList}}` `{{table}}` |
| **Product** | `{{product}}` `{{size}}` `{{customer}}` `{{account}}` `{{item}}` `{{division}}` |
| **Quantities** | `{{totalCases}}` `{{totalPallets}}` `{{totalWeight}}` |
| **Logistics** | `{{collectionDate}}` `{{collectionAddress}}` `{{deliveryAddress}}` `{{finalDelivery}}` `{{forwarder}}` |
| **People** | `{{vendorContact}}` `{{recipientName}}` `{{senderName}}` `{{signature}}` `{{docsEmail}}` |
| **Airport** | `{{airport}}` `{{airportCode}}` `{{airportName}}` |
| **Other** | `{{today}}` |

Every one traces back to a PO field, arithmetic over a PO and a tracker constant, or something
typed into the account record. There is no generated prose anywhere.

When you import a template containing literal values — a customer name, a contact — the editor
offers to swap them for placeholders and shows exactly which. Nothing is changed until you
click.

### Fields in this template

Every draft opens with a panel listing each placeholder the template uses, the value it will
send, and where that value came from — `filled`, `derived`, `typed in`, or `missing`.

**A missing field is raised before the preview, not left to be spotted in the text.** Each one
gets a box to type a value into, and typing there applies to that draft only — the template and
the tracker are untouched. Nothing is ever invented to cover a gap; an unfilled placeholder goes
out as empty braces unless you fill it.

### Airport codes

A purchase order names its delivery point in words — *AEROPUERTO INTERNACIONAL CIUDAD DE
MEXICO* — while a trucker's template wants *MEX*. Where a template quotes an airport, the code
is read from the delivery address:

1. **A code already printed on the PO wins.** Nothing is derived when the document says it.
2. **Otherwise the address is matched against a built-in airport table**, by the airport's name
   first and then by city. The result is labelled `derived` and the panel says to check it.
3. **Where a city has more than one airport, nothing is chosen.** *London* offers LHR, LGW, STN,
   LTN and LCY and waits for you to pick. Sending wine to Gatwick because the address said
   "London" is exactly the mistake the table exists to prevent.

### The internal note on an imported template

Templates often end with a note to whoever filed them — `Use: Aeromexico`. On import, that line
and everything after it is removed from the copy the portal keeps. The editor shows what was
taken out and offers **Put it back** if the guess was wrong.

**The file you uploaded is never written to.** Its note stays where it is.

### Editing

The template editor has a live preview filled with whatever orders you have loaded, so you see
the real thing before saving. **Save** writes to the shared folder and everyone on that account
gets it. The Emails tab also has a per-draft editor for one-off changes that should not become
the template.

---

## Attachments

Three sources, and the draft says which is which:

| | |
| --- | --- |
| **The PO PDFs** | The orders in hand for this item. One checkbox, on by default for vendor mail. |
| **Standing files** | Kept on the item in the shared folder, attached to every message for it. |
| **This draft only** | Added in the preview, used once, never saved anywhere. |

**Manage files sent with every message** copies a file into `attachments/<account>/<item>/` in
the shared folder, so a colleague opening the same workspace attaches the same file — a link to
somebody's desktop would break for everyone else. Each standing file can be limited to certain
kinds of message (customer only, say) or left to go on all of them.

If a standing file has been deleted from the shared folder, the draft refuses to build and says
which file is missing rather than sending a message that is quietly short an attachment.

## Recipients

For vendor emails the address printed on the purchase order always wins, and the app says so
next to the field. Otherwise it uses the item's contact for that counterparty, falling back to
the account's. Cc combines the PO's document address, the account's standing Cc, the item's and
account's per-role Ccs, and your personal Cc, deduplicated.

An unset contact produces an empty To box — never a guess.

---

## Concurrent edits

`workspace.json` carries a timestamp and the name of whoever last saved it. If a colleague
saved while you were editing, you are told who and when, and asked whether to overwrite or
reload theirs. Nothing is silently clobbered.

Trackers are unchanged from the single-account version: a timestamped backup is written
beside the file before every post.

> Close a tracker in Excel before posting to it. Excel locks open workbooks.

---

## Working on the app

```
portal/
  AMI-Order-Desk.html             single-account build
  AMI-Order-Desk-Teams.html       multi-account build
  build.js                        produces both
  src/
    engine.js                     ZIP, XLSX, PDF, planning, validation, follow-ups, EML
    templates.js                  .msg/.oft/.eml/.docx ingestion, RTF de-encapsulation
    airports.js                   airport table and address lookup
    workspace.js                  divisions, accounts, items, people, templates, attachments
    status.js                     the four stages, derivation, contracts, schedule, roll-ups
    charts.js                     stat tiles, bars, columns, stage fills
    persist.js                    remembering the folder and unposted work
    app.js / app-teams.js         the two interfaces
    styles.css                    shared
    shell.html / shell-teams.html
  tests/
    engine.test.js       128 assertions   PO extraction, tracker maths, write-back, follow-ups
    ui.test.js            58 assertions   single-account app in Chromium
    teams.test.js        137 assertions   templates, workspace model, routing, airports, attachments
    status.test.js       175 assertions   stages, contracts, lateness, schedule, roll-ups, charts
    teams-ui.test.js     180 assertions   multi-account app, dashboard, drill-down, persistence
```

```bash
node portal/build.js
node portal/tests/engine.test.js <fixturesDir>
node portal/tests/teams.test.js <fixturesDir>
node portal/tests/status.test.js <fixturesDir>
node portal/tests/ui.test.js <fixturesDir>          # needs playwright
node portal/tests/teams-ui.test.js <fixturesDir>    # needs playwright
```

### Colour, and not depending on it

Chrome uses one blue accent. Order stages use a **separate single-hue ordinal ramp**, so a stage
colour can never be mistaken for a button, and *further along the pipeline* always reads as
*stronger* — darker on the light theme, lighter on the dark one. Both ramps were checked with
the data-visualisation validator for monotone lightness, visible step gaps and contrast against
their own surface; dark mode is its own set of steps, not an automatic inversion. The reserved
good/warning/critical colours are used only for health and never for a series, and always ship
with an icon and a word so colour never carries meaning alone.

**Every stage also carries a weave**, and that is the primary signal:

| Stage | Fill |
| --- | --- |
| Order placed – awaiting shipment | solid |
| In transit | diagonal stripes |
| Delivered | horizontal stripes |
| Invoiced and Closed | vertical stripes |

Four stages on one hue is the hardest case for a reader with colour vision deficiency, so hue is
never asked to work alone. The weave appears on bar segments, legend swatches, board headings,
card rails and stage pills; the legend **names** each weave in words as well as showing it, so
the key survives being read aloud, printed in grey or photocopied.

A row that measures something other than pipeline position — an order's age, a count — takes the
reserved status palette instead. A weave there would claim a stage the row does not have.

Fixtures (a sample PO PDF, a tracking chart, a saved `.msg`) are **not** committed — they hold
customer data. Point the tests at a local folder containing them. The multi-item browser test
clones the sample tracker with a different item code to stand in for a second product, so one
tracking chart is enough to exercise routing.

An account written before items existed — a single `trackerPath` — is migrated to one item
automatically on load, so an earlier `workspace.json` keeps working.

### Without folder access

Firefox and Safari cannot open folders. There, use **Load a workspace bundle** — a `.zip` of
`workspace.json` and the templates, produced by **Export workspace bundle**. Changes stay in
that browser until you export a new bundle, so it is a stopgap, not a way to collaborate.
