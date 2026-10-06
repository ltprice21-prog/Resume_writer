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
  order-work.json                     ticked checklist steps, tasks, flags, activity
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

## The layout: rail, top bar, drawer

The app is laid out like the Global Wine Operations Hub. A **rail** down the left holds every
page (a bar along the bottom on a phone). A **top bar** holds search, *I am* — who you are —
and **+ New order**, which takes you to the purchase-order page. Below it, a thin strip chooses
which account and item you are entering orders for. Orders open in a **drawer** on the right, so
the list behind them keeps its place. Light and dark both follow the computer's setting.

| Rail (Work section, in this order) | What it is |
| --- | --- |
| **My Work** | What needs you today: tasks that have fallen due, open flags, tracker dates in the next 14 days, person checks waiting, chases to send |
| **Account Health** | The dashboard — contracts, what is coming, the pipeline, what needs attention |
| **Tasks** | The standard steps for each open order's current stage, across all orders |
| **Flagged** | Things that need attention, with severity and an answer for each |
| **Follow-ups** | Blank tracker cells being chased, and the draft emails |
| **Orders** | Every open order and where it stands; click a PO to open it |
| **Shipments** | Every collection and delivery, from the tracker's dated columns |
| **Invoiced archive** | Orders with an invoice number in the tracker — closed, off the dashboards and follow-ups — with their settlement columns |
| **Order trackers** | Edit the tracker workbooks themselves (see below) |

The order desk follows: **Purchase orders → Review & post → Emails**, then **Templates**,
**Accounts & people** and **Workspace** for setup.

**Search** (press `/`) finds an order by PO, account, item, lot number, NAV invoice or a word in
the tracker's notes, and opens its drawer.

### The order drawer

Everything about one order in one place: the twelve stages in four phases with what the tracker
shows done; the stage control; the checklist for the stage being worked; exceptions; the
tracker's own dates and quantities; chases still open; and an activity log.

### Stage checklists

Each stage has the division's standard steps — *Confirm PO details*, *Create the supplier PO*,
*Schedule collection*, and so on. They are the process, held in the app; they are not read from
anything and say nothing about a particular order. A step is **done only because a person ticked
it**, and the tick records who and when. The tracker moving on never ticks anything, and ticking
never moves the tracker or the order's stage.

A step has a **due date only where the tracker gives one**: logistics steps are due three days
before the requested collection date, documentation two, pre-shipment one, shipment steps on the
collection date, delivery on the customer's required date. Each says which date it came from.
Steps with no anchor have no due date until someone sets one. Anyone can add their own task to an
order, give a step an owner, or set a date.

The steps shown are for the stage an order is **working on** — the one after the furthest it has
reached.

### Flagged

The **Flagged** page lists these. Items are flagged automatically, from the tracker and nothing else, and each says which dates produced it:

| Flag | When | Severity |
| --- | --- | --- |
| Collection overdue | The requested collection date has passed with no collection recorded | High; Critical at 7 days |
| Delivery overdue | The customer's required date has passed with no delivery recorded | High; Critical at 7 days |
| Documents still blank | A documents chase is live and collection is within 3 days or past | High; Critical within a day |
| Delivered, not invoiced | Delivered 3 or more days ago and no NAV invoice number | Medium |
| Date looks mistyped | A tracker date outside the plausible window (ignored, as before) | Medium |
| Stage behind the tracker | A stage set by hand is earlier than the tracker shows | Low |

Closed orders raise nothing. Anyone with the permission can also **raise one by hand**, with a
type, severity, due date and detail. Every exception can be **acknowledged**, **escalated** and
**resolved** — resolving needs an answer (*Fixed by supplier*, *Tracker corrected*, …) and
optionally a root cause. If the tracker is corrected and an automatic flag's cause goes away, it
reads *Cleared* rather than vanishing, and can be archived.

### Shipments

One line per order: where it is (*Awaiting collection*, *Collected, not yet delivered*,
*Delivered*, or *No collection date in the tracker*), the four dates, truck type, cases, pallets
and lot. All of it is tracker columns. Where the tracker is blank the page says so.

---

## Order trackers

**Order trackers** is the last page in the Work section. It opens an item's tracker workbook as an
editable table — every column, newest order first, with a PO search — and writes what you change
back into the workbook in the shared folder.

- **Pick the tracker** from the list of every item on your accounts. Type into any cell: dates use
  a date picker, numbers and text are typed. Changed cells turn amber and a bar counts them.
- **Save to the tracker** writes the workbook. Before it does, a **backup** is written beside it
  (`… (backup 2026-10-01 1830).xlsx`), the same as when posting purchase orders.
- **Formulas are never touched.** A cell the sheet calculates is shown greyed and cannot be
  edited. If any edit would land on one, the whole batch is refused by name and nothing is
  written. After a save, the cached results of the formulas beneath an edit (running contract
  balances, for example) are brought up to date, and Excel is told to recalculate on open.
- **Collisions are refused.** If a colleague saved the workbook since you opened it, you are told
  and saving is blocked until you reload — their change is never overwritten.
- **It syncs across the platform.** Every page reads the same workbook, so on saving, the stage of
  an order, the dashboards, Follow-ups, Flagged, Shipments and the Invoiced archive all update at
  once — enter a collection date and the order moves to Shipment Execution; enter a NAV invoice
  number and it leaves for the archive. Colleagues get it when the shared folder syncs and they
  next open or return to the app (it re-reads the trackers when the tab regains focus).
- **Who changed what** is written to each order's activity log, shown in its drawer.

Needs the *Edit order trackers* permission. Close the workbook in Excel first — Excel locks open files.

---

## Roles and permissions

**Accounts & people** lists everyone. An administrator edits a person: a **role** sets a starting
point, then each permission can be ticked or unticked for that person. There are two roles:
**User** and **Administrator**. An administrator can change anyone's role to Administrator, or back.
Workspaces saved with the older Order desk, Finance and Viewer roles open as *User*, keeping the
permissions those roles had.

| Permission | Administrator | User (starting point) |
| --- | :-: | :-: |
| Add purchase orders and post to trackers | ✓ | ✓ |
| Change an order's stage | ✓ | ✓ |
| Tick off and add stage tasks | ✓ | ✓ |
| Flag, acknowledge and resolve flagged items | ✓ | ✓ |
| Edit order trackers | ✓ | ✓ |
| Draft emails and chases | ✓ | ✓ |
| Edit email templates | ✓ | ✓ |
| **Add and edit accounts and items** | ✓ |  |
| **Add people and change roles and permissions** | ✓ |  |

**Testing setup: everyone starts as an administrator.** A new person, and anyone saved without a
role, gets the workspace's default role — *Administrator* for now. On **Accounts & people**, *New
people start as* changes it (`settings.defaultRole` in `workspace.json`); set it to *User*
before real use. Someone already saved as an administrator stays one. A workspace always keeps at least one administrator, and the first
person added to an empty workspace is made one.

A control the role does not allow is switched off with the reason in its tooltip.

> **This shapes what the app offers; it does not lock files.** Anyone who can open the shared
> folder can open any file in it. Material that must be genuinely restricted belongs in a
> folder with its own SharePoint permissions.

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

### The twelve-stage workflow

The division's workflow, grouped into four phases:

| # | Stage | Phase | Done when |
| --- | --- | --- | --- |
| 1 | Purchase Order Received | Order intake | the tracker records *PO Received Date* |
| 2 | Order Validation | Order intake | **a person marks it done** — no column records it |
| 3 | Supplier PO Creation | Order intake | the tracker records *PO date sent to winery* |
| 4 | Supply Confirmation | Supply & preparation | the tracker records *Winery Confirmed Available Date* |
| 5 | Logistics Planning | Supply & preparation | the tracker records *Truck Type* |
| 6 | Documentation Management | Supply & preparation | the tracker records *Bottling Date Confirmed* and *Lot Number* |
| 7 | Pre-Shipment Review | Supply & preparation | **a person marks it done** — no column records it |
| 8 | Shipment Execution | Shipment | the tracker records *Actual Collection Date from Cellars* |
| 9 | Delivery Confirmation | Shipment | the tracker records the delivery date |
| 10 | Customer Invoicing | Financial close | the tracker records *NAV INV #* |
| 11 | Supplier Settlement | Financial close | the tracker records *Winery invoice received*, *Proof of Export Sent to Winery* and *Forwarder's invoice received date for ACCT* |
| 12 | Order Closure & Reporting | Financial close | stages 10 and 11 are both done on the tracker, or a person closes it. Stages 10, 11 and 12 all count as closed |

An order sits at the **furthest stage it has completed**, and every view names the stage it is
waiting on next. Where a stage needs several columns, every one the sheet carries must be filled
(`to fill` counts as blank); a column an older cycle sheet does not have is skipped.

**Order Validation and Pre-Shipment Review are never read from the tracker.** They are checks a
person makes, and no column records that they happened. The tracker can carry an order past them —
a collection date puts it at Shipment Execution — but that shows the order moved on, not that the
check was made, and the per-order trail shows the check as *not recorded*.

**An invoiced order is closed, and the pipeline is bypassed.** The moment the tracker records a NAV
invoice number the order is closed — whatever stage it was at or had skipped, and whatever stage
anyone set by hand. It is removed from **every dashboard and open list** (Account Health, Orders,
My Work, Tasks, Flagged, Shipments) and from **Follow-ups**, and is kept in the **Invoiced
archive**. A person can also close an order by setting Customer Invoicing or later.

The archive shows the winery invoice, proof of export and forwarder's invoice columns beside each
order, and says *Waiting on 2* where any are blank — for reference. Those blanks are **not
chased**: an invoiced order is out of the follow-ups altogether. An order stays archived until its
NAV invoice number is removed from the tracker (one closed by hand can be reopened by setting an
earlier stage).

Settlement columns filled *without* an invoice number do not close an order. Contract standing
(balance, most recent delivery) is a fact about the contract, not a list of orders, so it still
reads every order on the tracker.

Statuses stored under the old four-stage pipeline read as their new stage and say so: *Order
placed* → Supplier PO Creation, *In transit* → Shipment Execution, *Delivered* → Delivery
Confirmation, *Invoiced and Closed* → Order Closure & Reporting (the person meant closed, so it
stays closed).

On the **Order status** page each order shows its trail through all twelve stages, and the
workflow itself — each stage, what records it, and which follow-ups belong to it — is written out
at the foot of the page.

### Hiding what is finished

Dashboards and open lists never include invoiced orders. The **Orders** page has a button saying
how many are in the **Invoiced archive**.

Set them on the **Order status** page — a table with a dropdown per order, a bulk "set selected
to…", and filters including *Open only* and *No status set*. Anything you set there is what the
dashboard shows.

### Where a status comes from

Every order's stage is one of two things, and the interface always says which:

| | |
| --- | --- |
| **Set by a person** | Chosen on the Order status page or by dragging a kanban card. Records who and when. |
| **From the tracker** | Read from the columns already in the workbook — see the table above for which column records which stage. |

The two person checks have no column behind them, so they only ever come from a person. A status
set behind what the tracker already shows is kept — a person's choice stands — but the reason
says the tracker is further along, and the next stage is counted from the tracker.

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

**Everything shared** — statuses, ticked steps, tasks, exceptions, activity, templates, people and
permissions, workspace configuration, tracker rows — is written
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

A template is filled by scanning the purchase order PDFs. Anything in double braces is a
placeholder, and it can be written as free text — `{{poList}}`, `{{Lot Number}}`, `{{Truck Type}}`.
Names are compared ignoring case, spaces and punctuation.

**Where a value comes from, in this order:**

1. **The PO scan** — the names below, read off the PDF or worked out from it.
2. **The item tracker**, for anything the scan did not give. A placeholder whose name matches a
   **tracker column heading** takes that column's value for the PO(s) in the draft:
   `{{Lot Number}}`, `{{Truck Type}}`, `{{NAV INV #}}`, `{{Winery Confirmed Available Date}}`. It
   also matches the facts at the top of the sheet: `{{Supplier}}`, `{{HS/HTS Code}}`,
   `{{Country of Origin}}`, `{{Case weight}}`, `{{Collection Location}}`, and so on. Where the PO
   names a field but the scan found nothing for it (`{{forwarder}}`), the tracker's column of the
   same name fills the gap.
   **Fixed names** read one tracker heading, always from the tracker and never from the PO:
   `{{Item name}}` = Product Name, `{{Case and Pack Size}}` = Case size, `{{Final customer}}` =
   Customer, `{{Shipment Method}}` = Method of Shipment, `{{Country of Origin}}` = Country of
   Origin, `{{Shipping agent name}}` = Forwarder.
   **`{{US/Int team email}}`** is a field on each person (*Accounts & people → Edit → US/Int team
   email*), set by an administrator. A draft uses the address of the person drafting it.
3. **Nothing** — left empty, never guessed, and reported on the *Fields in this template* panel.

A name that fits more than one tracker column (`{{Quantity}}` is three) is reported as ambiguous
with the candidates; use the exact heading. The fields panel shows a *from tracker* chip beside
every value that came from the sheet, with the column it came from, and says exactly why a field
is empty — a blank tracker cell, a PO that is not on the tracker yet, or no such name anywhere.

| | PO-scan names |
| --- | --- |
| **Order** | `{{poCount}}` `{{poGroups}}` `{{poList}}` `{{table}}` |
| **Product** | `{{product}}` `{{size}}` `{{customer}}` `{{account}}` `{{item}}` `{{division}}` |
| **Quantities** | `{{totalCases}}` `{{totalPallets}}` `{{totalWeight}}` |
| **Logistics** | `{{collectionDate}}` `{{collectionAddress}}` `{{deliveryAddress}}` `{{finalDelivery}}` `{{forwarder}}` |
| **People** | `{{vendorContact}}` `{{recipientName}}` `{{senderName}}` `{{signature}}` `{{docsEmail}}` |
| **Airport** | `{{airport}}` `{{airportCode}}` `{{airportName}}` |
| **Other** | `{{today}}` |

Every one traces back to a PO field, a tracker cell, arithmetic over those, or something typed into
the account record. There is no generated prose anywhere. Follow-up (chase) emails resolve
placeholders the same way, against the tracker rows being chased.

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

### Nothing after the sign-off

A template ends at its closing — `Best regards,`, `Kind regards,`, `Thank you and kind regards,`
— and the sender's `{{signature}}`. Anything else after the closing (`Use: Aeromexico`, reminders,
an old typed signature) is removed:

- **On import**, from the copy the portal keeps. The editor shows what was taken out and offers
  **Put it back** if the guess was wrong. The file you uploaded is never written to.
- **On every save.**
- **On templates already saved.** When an account loads, any saved template with text after its
  sign-off is cleaned and, for someone allowed to edit templates, rewritten in the shared folder.

Placeholders after the closing (`{{signature}}`) stay, and so do images. A bare `Thanks,` counts as
the closing only when the template has nothing clearer. A template with no closing is only trimmed
if it has a `Use:` note.

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

`order-status.json` and `order-work.json` are merged **entry by entry**, newest wins, rather than
refused whole. Two people working different orders — or different steps of one — both keep their
changes; only two edits to the very same step at the same moment resolve to the later one.
Activity logs are combined, not replaced.

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
    status.js                     the twelve-stage workflow, derivation, contracts, schedule, roll-ups
    orderwork.js                  stage checklists, exceptions, shipment lines, order-work.json
    charts.js                     stat tiles, bars, columns, stage fills
    persist.js                    remembering the folder and unposted work
    app.js / app-teams.js         the two interfaces (app-teams.js: workspace, desk, dashboard)
    app-hub.js                    My Work, Tasks, Flagged, Shipments, Invoiced archive, the order drawer, search
    app-trackers.js               the Order trackers page: edit tracker rows in place
    styles.css                    shared
    shell.html / shell-teams.html
  tests/
    engine.test.js       128 assertions   PO extraction, tracker maths, write-back, follow-ups
    ui.test.js            58 assertions   single-account app in Chromium
    teams.test.js        137 assertions   templates, workspace model, routing, airports, attachments
    status.test.js       175 assertions   stages, contracts, lateness, schedule, roll-ups, charts
    workflow.test.js      71 assertions   the twelve-stage workflow — needs no fixtures
    orderwork.test.js     51 assertions   checklists, exceptions, shipments, merging, permissions — no fixtures
    hub-ui.test.js        58 assertions   the new pages, drawer, search, trackers and permissions in Chromium — no fixtures
    trackeredit.test.js   25 assertions   editing tracker rows in place, formulas preserved — no fixtures
    teams-ui.test.js     180 assertions   multi-account app, dashboard, drill-down, persistence
```

```bash
node portal/build.js
node portal/tests/engine.test.js <fixturesDir>
node portal/tests/teams.test.js <fixturesDir>
node portal/tests/status.test.js <fixturesDir>
node portal/tests/workflow.test.js                  # no fixtures needed
node portal/tests/orderwork.test.js                 # no fixtures needed
node portal/tests/trackeredit.test.js               # no fixtures needed
node portal/tests/hub-ui.test.js                    # needs playwright; no fixtures
node portal/tests/ui.test.js <fixturesDir>          # needs playwright
node portal/tests/teams-ui.test.js <fixturesDir>    # needs playwright
```

### Colour, and not depending on it

Chrome uses one wine-coloured accent (the hub's). Order stages use a **separate single-hue ordinal ramp**, so a stage
colour can never be mistaken for a button, and *further along the pipeline* always reads as
*stronger* — darker on the light theme, lighter on the dark one. Both ramps were checked with
the data-visualisation validator for monotone lightness, visible step gaps and contrast against
their own surface; dark mode is its own set of steps, not an automatic inversion. The reserved
good/warning/critical colours are used only for health and never for a series, and always ship
with an icon and a word so colour never carries meaning alone.

**Every phase also carries a weave**, and that is the primary signal:

| Phase | Stages | Fill |
| --- | --- | --- |
| Order intake | 1–3 | solid |
| Supply & preparation | 4–7 | diagonal stripes |
| Shipment | 8–9 | horizontal stripes |
| Financial close | 10–12 | vertical stripes |

Twelve fills cannot all stay distinct for a reader with colour vision deficiency, so fills belong
to the four phases and **the stage itself is always named in words** — numbered, on pills, board
columns, bars and the trail. The weave appears on bar segments, legend swatches, board headings,
card rails and stage pills; the legend names each weave in words as well as showing it, so the key
survives being read aloud, printed in grey or photocopied.

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
