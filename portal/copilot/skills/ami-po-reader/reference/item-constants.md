# Item constants

Every calculated figure on a tracker row depends on this file. Keep it current.

These live in the top-left block of each Order Tracking Chart. They are repeated
here because that block is laid out for a person reading a spreadsheet, and is
read unreliably by anything else.

**When a constant changes on a chart, change it here the same day.** A stale
`cases per pallet` produces a wrong pallet count, a wrong freight booking, and a
number nobody checks because it looks reasonable.

---

## Evidencia Tempranillo Spain

| | |
| --- | --- |
| NAV code | `EVDTMPRNV` |
| Airline part / item # | `VIN1003` |
| Customer | Aeromexico |
| Supplier | SAS Vins Beicher |
| Case size | 12 × 1L |
| **Bottles per case** | **12** |
| **Cases per pallet** | **48** |
| Case weight | 12.77 kg |
| Full pallet weight (incl. pallet) | 638 kg |
| Production lead time | 37 days |
| **Transit days (water/road)** | **2** |
| Country of origin | Spain |
| HS code | 22042182 |
| Collection | 1 route de Rodern, 68590 Saint Hippolyte, France |
| Winery closed | 12/22 – 1/5. Last PO 12/5; first collection after closure 1/6 |
| Minimum order | 5 pallets (group with red/white) |

---

## Short form, for a tight instructions box

Microsoft 365 Copilot's Agent Builder caps instructions at 8,000 characters and
the full skill does not leave room for the table above. Paste this instead — it
carries the four constants the arithmetic actually uses, and nothing else:

```
## Item constants

Evidencia Tempranillo Spain — NAV code EVDTMPRNV — customer Aeromexico
  Bottles per case 12 · Cases per pallet 48 · Full pallet weight 638 kg · Transit days 2

If an item is not listed here, ask for its constants. Never borrow another item's.
```

Add one line per item as the range grows. Copilot Studio has room for the full
table, so use that there.

## Adding an item

Copy the block above and fill it from the chart's top-left panel. The four in
**bold** are the ones the arithmetic uses:

```
Bottles = Qty (cases) × Bottles per case
Pallets = Qty (cases) ÷ Cases per pallet
Weight  = Pallets × Full pallet weight
Customer Required Delivery Date = Pickup Date + Transit days   (only when the PO has no Delivery Date)
```

If an item is missing from this file, the correct behaviour is to **ask for its
constants**, not to borrow another item's. Bottles per case differs across the
range, and a borrowed pair produces a wrong answer that looks entirely plausible.
