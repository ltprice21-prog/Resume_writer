---
name: ami-po-reader
description: Reads an AMI Group purchase order PDF and produces the single row to add to that item's Excel Order Tracking Chart, plus a list of every field the purchase order does not carry. Use when someone supplies a purchase order and needs the tracker row, asks what a PO does or does not contain, or asks which cells they must fill in by hand. Covers the NAV purchase order field labels, the bottles and pallets arithmetic, the per-item constants, the four tracker columns whose formulas must never be overwritten, and the cross-checks that catch a duplicate or misrouted purchase order.
---

# AMI purchase order reader

Turn one AMI Group purchase order PDF into one row for that item's Order Tracking
Chart, and say plainly what the purchase order does not tell you.

## The rule that overrides every other instruction

**Never invent, infer, estimate or complete a value.** Every figure you output is
either copied from the purchase order, or calculated by the arithmetic below from
figures printed on that same purchase order and the item constants in this file.

If a value is not there, write `BLANK`. Never a plausible value, never a value
carried over from another order, never a typical or expected one. **A blank cell
is correct and useful. A guessed cell is a shipping error** — these rows book
lorries and tell airlines when their wine arrives.

Three habits enforce this:

1. Every row you output ends with a list of every `BLANK`.
2. Every calculated figure is shown with the sum you used.
3. Anything you are unsure you read correctly is named, marked `BLANK`, and
   explained — never quietly filled.

Do not round, do not reformat numbers, do not convert units beyond the arithmetic
below.

## What a NAV purchase order carries

Read the value to the right of each printed label, or the block beneath it.

| Label on the PO | What it is |
| --- | --- |
| `Order No.` | The PO number, e.g. `350633-2` |
| `Order Date` | When the order was raised |
| `Pickup Date` | When AMI is asking the winery to have it ready |
| `Delivery Date` | When the customer needs it — **often absent** |
| `Shipping Agent` | The forwarder, e.g. `STPI` |
| `Shipment Method` | e.g. `Ex Works` |
| `Item No.` | The NAV item code, e.g. `EVDTMPRNV` |
| `Description` | The product, e.g. `Evidencia Tempranillo Spain` |
| `Qty` | The quantity **in cases** |
| `Vendor:` | Block — winery name, address, contact name, email |
| `Ship To:` | Block — the consignee and the forwarder's depot |
| `FOR FINAL DELIVERY TO:` | Block — the airline's bonded store |

`Qty` is always cases. It is never bottles.

## Item constants

These are **not on the purchase order**. They live in the top-left block of the
item's tracking chart, repeated here because that block is laid out for a person
reading a spreadsheet and is read unreliably by anything else.

| Item | NAV code | Customer | Bottles/case | Cases/pallet | Full pallet kg | Transit days |
| --- | --- | --- | --- | --- | --- | --- |
| Evidencia Tempranillo Spain | `EVDTMPRNV` | Aeromexico | 12 | 48 | 638 | 2 |

Evidencia detail: supplier SAS Vins Beicher · case 12 × 1L · case weight 12.77 kg ·
production lead time 37 days · origin Spain · HS 22042182 · collection 1 route de
Rodern, 68590 Saint Hippolyte, France · winery closed 12/22–1/5, last PO 12/5,
first collection after closure 1/6 · minimum order 5 pallets.

**If an item is not in this table, ask for its constants.** Do not assume them and
do not carry them over from a different item — bottles per case and cases per
pallet differ across the range, and a borrowed pair silently produces a wrong
pallet count and a wrong freight booking.

**When a constant changes on a chart, change it here the same day.** A stale
cases-per-pallet produces a number nobody checks, because it looks reasonable.

## The arithmetic

```
Bottles = Qty (cases) × [Bottles per case]
Pallets = Qty (cases) ÷ [Cases per pallet]
Weight  = Pallets × [Full pallet kg]
```

When the PO carries no `Delivery Date`:

```
Customer Required Delivery Date = Pickup Date + [Transit days]
```

Say plainly that you did this and which figures you used. **If you do not have
the transit days, leave it `BLANK`** rather than guessing a transit time.

## The row

Output a two-column table — tracker column, then value — in this order, using the
exact column letters and headings of the current cycle sheet.

| Col | Heading | Value |
| --- | --- | --- |
| A | PO# | `Order No.` |
| B | Quantity (bt) | calculated |
| C | Quantity (cs) | `Qty` |
| D | Quantity (pallets) | calculated |
| E | Bottling Date Confirmed | `BLANK` |
| F | Lot Number | `BLANK` |
| G | Ship To | first line of the `Ship To:` block |
| H | PO Received Date | `BLANK` — the person adds this |
| I | ORDERS MUST BE SEND TO WINERY PRIOR TO | **FORMULA — do not fill** |
| J | PO date sent to winery | `Order Date` |
| K | AMI Requested Collection Date | **FORMULA — do not fill** |
| L | Winery Confirmed Available Date | `BLANK` |
| M | Actual Collection Date from Cellars | `BLANK` |
| N | Delivery date to CDG | `BLANK` |
| O | Customer Required Delivery Date | `Delivery Date`, or calculated |
| P | Method of Shipment | `Shipment Method` |
| Q | Forwarder | `Shipping Agent` |
| R | Truck Type | `BLANK` unless the PO says |
| S | Balance on Contract (bt) | **FORMULA — do not fill** |
| T | Balance on Contract (cs) | **FORMULA — do not fill** |
| U | Winery invoice received | `BLANK` |
| V | Proof of Export Sent to Winery | `BLANK` |
| W | Forwarder's invoice | `BLANK` |
| X | Forwarder's invoice received date for ACCT | `BLANK` |
| Y | NAV INV # | `BLANK` |
| Z | Notes | `BLANK` |

Dates as `M/D/YYYY`. Quantities as plain numbers with no thousands separators, so
they paste cleanly into Excel.

> Column letters shift between cycle sheets — the 2025 sheet has an extra column,
> so its balance sits in T and U. Match on the **heading text**, never on the
> letter alone, and say which sheet layout you assumed.

### The four formula columns

Columns **I, K, S and T** compute themselves from the row and from the row above.
Never give a value for them.

Tell the user to **fill down from the row above first**, then type the remaining
values in. Typing over column S breaks the running contract balance for *every
row beneath it*, and nothing in Excel warns them.

### After the table

```
READ FROM THE PO        which columns were copied straight off the document
CALCULATED              each one with its sum, e.g. "B = 336 × 12 = 4,032"
YOU MUST FILL THESE IN  every BLANK
LEAVE ALONE             I, K, S, T — fill down from the row above
CHECK THIS              anything uncertain, and why
```

## Cross-checks — run all five, every time

1. **Item match.** Does `Item No.` on the PO match the NAV code of the tracking
   chart? If not, **stop**. Say the PO may belong to a different item and output
   no row. A PO posted to the wrong chart corrupts two contract balances at once.
2. **Duplicate.** Is this PO number already on the sheet? If you have the sheet,
   check and say so. A PO posted twice is the most expensive mistake here.
3. **Whole pallets.** Does `Qty` divide cleanly by cases per pallet? If not, say
   so — part pallets change the freight cost and the booking.
4. **Date sanity.** Is `Pickup Date` before `Order Date`, or more than a year
   after it? Say so.
5. **Impossible years.** Does any date read as a year before 2000 or more than
   three years out? These charts contain real typing errors — a delivery date
   reading 3036, collection dates reading 2626. Mark it `BLANK` and name the
   field.

## Boundaries

- **You produce the row; a person pastes it.** If asked to write to the tracking
  chart, explain that this is deliberate — the sheet's formulas must not be
  overwritten by an automated paste.
- **A scan with no text layer cannot be read reliably.** Say so and stop. Do not
  read figures off an image of a document.
- **One PO, one row.** For a batch, output them one at a time, each with its own
  checks.
- Be terse. The table and the five lists, nothing else. No preamble, no
  explanation of what a purchase order is, no offer to help further.
