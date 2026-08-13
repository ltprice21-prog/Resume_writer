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

**Accounts → Edit an account → Item trackers → Add item tracker.** Name it, then pick its
workbook from the folder — the picker lists every spreadsheet it finds and marks any already
claimed by another item, so two items cannot quietly share one sheet. Leave the sheet blank
and the app uses the last one carrying a `PO#` header.

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

The landing page. It reads every item tracker across the accounts you can see, and shows where
the work actually is:

- **Headline figures** — open orders, how many sit at each stage, follow-ups overdue, and the
  longest an open order has gone without a dated event.
- **Order pipeline** — one stacked bar across the five stages, with a legend carrying the counts.
- **Orders by account** and **cases collected per month** — proportion and throughput.
- **Longest without movement** — the eight open orders that have sat still longest.
- **Account health** — one row per account, marked *On track*, *Needs attention* or *At risk*.
- **Pipeline board** — a kanban of every order; drag a card between columns to change its stage.

Filter by **division**, **account** and **item**. The division list only offers divisions you
actually have accounts in, so the filter can never show you an empty world by accident.

### The five stages

`Order placed – awaiting shipment` → `In transit` → `Delivered` → `Invoiced` → `Closed`

**Closed is the end of the line, so everything short of it counts as open** — including
*Invoiced*, unless the rule below closes it for you.

### Invoiced orders close themselves

On by default: **an order the tracker shows as invoiced reads as Closed.** The rule applies
only where the stage came from the tracker, so an explicit choice always stands — pick
*Invoiced* on an order by hand and it stays invoiced. Rows closed this way say so, quoting both
the evidence and the rule: *"a NAV invoice number is recorded. Closed automatically, because
this workspace treats invoiced orders as closed."*

Turn it off with the checkbox on the Order status page and invoiced orders stay open until
someone closes them. It is a workspace-wide setting, so only administrators change it; everyone
else sees its state and why they cannot.

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

*Needs attention* and *At risk* come from two explicit signals, printed next to the verdict:
days an open order has gone without a dated event (amber past 21, red past 45), and outstanding
follow-up items (amber at 1, red at 5). There is no score and no weighting to reverse-engineer;
the thresholds are one edit in `HEALTH_THRESHOLDS`.

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
| **Other** | `{{today}}` |

Every one traces back to a PO field, arithmetic over a PO and a tracker constant, or something
typed into the account record. There is no generated prose anywhere.

When you import a template containing literal values — a customer name, a contact — the editor
offers to swap them for placeholders and shows exactly which. Nothing is changed until you
click.

If a template uses a placeholder with no value behind it, the draft says so rather than
sending `{{something}}` to a vendor.

### Editing

The template editor has a live preview filled with whatever orders you have loaded, so you see
the real thing before saving. **Save** writes to the shared folder and everyone on that account
gets it. The Emails tab also has a per-draft editor for one-off changes that should not become
the template.

---

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
    engine.js                     ZIP, XLSX, PDF, planning, validation, EML
    templates.js                  .msg/.oft/.eml/.docx ingestion, RTF de-encapsulation
    workspace.js                  divisions, accounts, people, template storage
    app.js / app-teams.js         the two interfaces
    styles.css                    shared
    shell.html / shell-teams.html
  tests/
    engine.test.js       118 assertions   PO extraction, tracker maths, write-back
    ui.test.js            58 assertions   single-account app in Chromium
    teams.test.js        103 assertions   template ingestion, workspace model, PO routing
    status.test.js       107 assertions   status model, the invoiced rule, roll-ups, charts
    teams-ui.test.js     110 assertions   multi-account app, dashboard and persistence
```

```bash
node portal/build.js
node portal/tests/engine.test.js <fixturesDir>
node portal/tests/teams.test.js <fixturesDir>
node portal/tests/status.test.js <fixturesDir>
node portal/tests/ui.test.js <fixturesDir>          # needs playwright
node portal/tests/teams-ui.test.js <fixturesDir>    # needs playwright
```

### Colour

Chrome uses one blue accent. Order stages use a **separate single-hue ordinal ramp**, so a stage
colour can never be mistaken for a button, and *further along the pipeline* always reads as
*stronger* — darker on the light theme, lighter on the dark one. Both ramps were checked with
the data-visualisation validator for monotone lightness, visible step gaps and contrast against
their own surface; dark mode is its own set of steps, not an automatic inversion. The reserved
good/warning/critical colours are used only for health and never for a series, and always ship
with an icon and a word so colour never carries meaning alone.

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
