# AMI Order Desk

A single HTML file that turns a purchase order PDF into a tracker row and a vendor
email, without retyping anything.

> **Working across several customer accounts?** See
> [README-Teams.md](README-Teams.md) for `AMI-Order-Desk-Teams.html`, which adds an
> Account Health dashboard, Europe/US divisions, per-user account lists, several item
> trackers per account, and shared trucker / customer / vendor templates stored in a
> SharePoint-synced folder. This file keeps the same single-account workflow; it shares
> the same visual design.

**Nothing is installed. Nothing is uploaded. No AI service is called.** Open
`AMI-Order-Desk.html` in Edge or Chrome and it runs entirely inside the browser tab,
on your own machine, offline.

---

## Getting started

1. Copy **`AMI-Order-Desk.html`** into the OneDrive folder that holds the order
   tracking chart.
2. Double-click it. Edge opens it as a normal page.
3. Right-click the tab → **Pin**, or drag the file to your taskbar, so it is one click away.

That is the whole installation.

### The five steps

| Step | What it does |
| --- | --- |
| **1 · Tracker** | Open the tracking chart. Case sizes, pallet counts, lead times and the contract balance are read out of the workbook itself. |
| **2 · Purchase orders** | Drop in one or more PO PDFs. Each is read straight out of the PDF text. |
| **3 · Review & post** | See exactly what will land in every column, and where it came from, before a single cell is written. |
| **4 · Vendor email** | An Outlook draft addressed from the PO, with the breakdown table filled in and the PDFs already attached. |
| **5 · Follow-ups** | Every order with a tracker column still blank past its normal turnaround, and a chase email for the ones you pick. |

---

## Why it cannot invent anything

This was the hard requirement, so it is enforced structurally rather than by good intentions.

Every value on the review screen is tagged with its origin, and there are only five:

| Tag | Meaning |
| --- | --- |
| `FROM PO` | Read off the PDF, next to a named label such as *Order No.* or *Pickup Date*. |
| `COMPUTED` | Arithmetic on PO quantities and the tracker's own constants. The screen shows the sum, e.g. *336 cs × 12 bottles/case*. |
| `FORMULA` | Your sheet already computes this column. The formula is carried down to the new row, not replaced with a number. |
| `CARRIED` | Identical across recent orders, so it is offered — flagged, because it was **not** read from this PO. |
| `BLANK` | Not on the PO. Left empty for a human. |

There is no sixth category, and no free text is generated anywhere. The email body is a
template you own and can edit; the only things substituted into it are the values above.

### Cross-checks that run on every order

The tracker computes some columns from others, which gives independent ways to catch a
bad read. The app posts nothing until these agree:

- **Duplicate PO** — refuses to post a PO number already in the sheet.
- **Collection date** — the sheet derives `AMI Requested Collection Date` from the customer
  delivery date. That result must equal the *Pickup Date* printed on the PO, or you get an error.
- **Quantity round trip** — the PO states cases; the sheet derives cases back from bottles.
  Those must match.
- **Whole pallets** — warns when cases ÷ cases-per-pallet is not a whole number.
- **Production lead time** — warns when collection falls inside the stated lead time.
- **Winery closure** — reminds you of the closure window before you confirm.

---

## What happens to your workbook

The tracker is edited surgically: one `<row>` is appended to the sheet's XML and the stored
dimension is widened. Everything else is copied through byte for byte.

Preserved: all other sheets, cell styles and number formats, conditional formatting,
cell comments and threaded comments, print settings, custom XML, and every existing formula.

New rows continue the sheet's own shared formulas — `Quantity (cs)`, `Quantity (pallets)`,
`ORDERS MUST BE SEND TO WINERY PRIOR TO`, `AMI Requested Collection Date` and both
`Balance on Contract` columns stay live formulas, translated to the new row number and
written with the correct cached result so the figures are right the moment the file opens.

**A timestamped backup is written before every post.** With folder access it lands beside
the tracker; otherwise it downloads.

### Saving in place

Choosing **Open the tracker folder** lets the app write straight back to the file in
OneDrive and drop the backup next to it. Edge and Chrome support this; the browser asks
for permission once per session.

If your browser or policy blocks that, use **Upload a copy instead** — the app hands back
an updated workbook to save over the original. Same result, one extra step.

> Close the tracker in Excel before posting. Excel holds a lock on open workbooks, and a
> file saved underneath it will be overwritten when Excel next saves.

---

## The vendor email

The draft downloads as a `.eml` file. Double-click it and Outlook opens it as an editable
draft — it is not sent, and nothing is transmitted by the app.

Filled in for you: recipient and Cc from the PO's vendor block and document instructions,
subject line, the breakdown table (bottles, cases, pallets, requested collection date), the
final delivery address quoted from the PO, and **the PO PDFs already attached**.

Left blank: bottling date and expiration date, because the winery supplies them. One button
sets them to *Please advise* when you want to ask.

Edit the wording once under **Settings → Templates** and every future draft follows it.
Placeholders available:

```
{{vendorContact}} {{customer}} {{product}} {{size}} {{poCount}}
{{poGroups}} {{poList}} {{docsEmail}} {{finalDelivery}} {{table}} {{signature}}
```

Set your signature and standing Cc under **Settings** once. Settings live in this browser
only; **Export settings** produces a JSON file to hand to a colleague.

---

## Follow-ups

Step 5 reads the tracker and lists orders where a column is still blank past its normal
turnaround — measured from a dated column in the same row, never guessed. `to fill`
placeholders count as blank.

Items are grouped by who owes them (winery, forwarder, internal). Tick the ones you want
and get one chase email naming the POs and the outstanding item.

The rules live in `FOLLOW_UP_RULES` in `src/engine.js` and match on column headings, so
renaming a tracker column means editing one line there.

---

## Working on the app

The distributable file is generated; edit the sources and rebuild.

```
portal/
  AMI-Order-Desk.html      <- the built file, the only one users need
  build.js                 <- inlines src/ into that file
  src/
    engine.js              <- ZIP, XLSX, PDF, planning, validation, EML
    app.js                 <- interface
    styles.css
    shell.html
  tests/
    engine.test.js         <- 118 assertions against a real PO and tracker
    ui.test.js             <- 58 assertions driving the built file in Chromium
```

```bash
node portal/build.js                       # rebuild AMI-Order-Desk.html
node portal/tests/engine.test.js <dir>     # dir holds a sample PO pdf + tracker xlsx
node portal/tests/ui.test.js <dir>         # needs playwright
```

Sample POs and trackers are **not** committed — they contain customer data. Point the
tests at a local folder holding one of each.

### Adapting it to another product or customer

Most of it adapts itself. The app reads the header row of whichever sheet you choose and
maps columns by their headings, so a differently shaped tracker works as long as the
headings are recognisable. Product constants come from the labelled cells at the top of
the sheet.

Two places encode assumptions worth knowing about:

- `PDF_COLUMN_MAP` in `src/engine.js` — which tracker heading is fed by which PO field.
- `readSheetConfig` — the labels searched for at the top of the sheet
  (*Bottles/case*, *cs/pallet*, *Production Lead Time*, *Lead Time on Water/Road*).

### Requirements

A Chromium-based browser (Edge or Chrome) from 2022 or later. The app uses the built-in
compression and file-system APIs; nothing is downloaded at runtime. Firefox and Safari can
read POs and generate emails but cannot save the tracker in place — use the upload path there.

Purchase orders must be text PDFs, which NAV-generated POs are. A scanned image PDF will be
reported as unreadable rather than guessed at.
