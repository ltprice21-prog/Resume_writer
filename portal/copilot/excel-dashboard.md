# The dashboard, as Excel formulas

**Read this first.** Of everything the portal does, the dashboard is the part that must *not*
move to Copilot. A language model reading a spreadsheet as text will miscount, and these are
numbers you act on — chasing a winery, telling a customer a delivery date, deciding a contract
is finished.

Excel already does this arithmetic perfectly and shows its working. Put the numbers here, and
use Agent 3 for the questions that need reading and explaining rather than counting.

---

## Where these go

Add a sheet called **Dashboard** to each Order Tracking Chart workbook.

Every formula below assumes the **2026 Cycle** layout, where the header is row **32** and the
orders start at row **33**. Check yours: click the cell holding `PO#` and note its row. If the
header is on row *n*, replace `33` with *n+1* throughout.

Column letters differ between cycles — the 2025 sheet has an extra column, so its balance sits
in T and U rather than S and T. **Check the letters against the sheet you are pointing at.**

Ranges run to row 1000 so new orders are counted without editing anything.

---

## 1 · Contract standing

```excel
Balance (bt)      =LOOKUP(2,1/('2026 Cycle'!$A$33:$A$1000<>""),'2026 Cycle'!$S$33:$S$1000)
Balance (cs)      =LOOKUP(2,1/('2026 Cycle'!$A$33:$A$1000<>""),'2026 Cycle'!$T$33:$T$1000)
Contract          =IF(B2<0,"OVER CONTRACT",IF(B2=0,"CLOSED","Open"))
```

`LOOKUP(2,1/(range<>""),values)` returns the value on the **last row that has a PO**, which is
where the running balance stands. It ignores blank rows below the data, so nothing breaks when
orders are added.

`Contract` assumes the balance is in `B2`. Point it at wherever you put it.

**A negative balance is real.** The 2025 sheet in the sample workbook stands at **−10,176 bt**.
Never wrap this in `MAX(0,…)`.

## 2 · Delivery dates

```excel
Most recent delivery   =MAXIFS('2026 Cycle'!$N$33:$N$1000,
                          '2026 Cycle'!$N$33:$N$1000,">"&DATE(2000,1,1),
                          '2026 Cycle'!$N$33:$N$1000,"<"&DATE(YEAR(TODAY())+3,1,1))

Furthest requested     =MAXIFS('2026 Cycle'!$O$33:$O$1000,
                          '2026 Cycle'!$O$33:$O$1000,">"&DATE(2000,1,1),
                          '2026 Cycle'!$O$33:$O$1000,"<"&DATE(YEAR(TODAY())+3,1,1))
```

The two date guards are not decoration. These workbooks contain real typing errors — a delivery
date reading **3036** and collection dates reading **2626**. Without the guards, one mistyped
cell becomes "the furthest requested delivery" and stays there. Format both cells as a date.

## 3 · Overdue — what sets account health

```excel
Collections overdue  =COUNTIFS('2026 Cycle'!$A$33:$A$1000,"<>",
                        '2026 Cycle'!$K$33:$K$1000,"<"&TODAY(),
                        '2026 Cycle'!$K$33:$K$1000,">"&DATE(2000,1,1),
                        '2026 Cycle'!$M$33:$M$1000,"")

Deliveries overdue   =COUNTIFS('2026 Cycle'!$A$33:$A$1000,"<>",
                        '2026 Cycle'!$O$33:$O$1000,"<"&TODAY(),
                        '2026 Cycle'!$O$33:$O$1000,">"&DATE(2000,1,1),
                        '2026 Cycle'!$N$33:$N$1000,"")

Worst collection     =IFERROR(TODAY()-MINIFS('2026 Cycle'!$K$33:$K$1000,
                        '2026 Cycle'!$K$33:$K$1000,"<"&TODAY(),
                        '2026 Cycle'!$K$33:$K$1000,">"&DATE(2000,1,1),
                        '2026 Cycle'!$M$33:$M$1000,""),0)
```

*Requested collection date has passed and nothing is recorded in the collection column.* That is
the whole definition.

## 4 · Met late — counted, but not chased

```excel
Collected late   =SUMPRODUCT(('2026 Cycle'!$A$33:$A$1000<>"")*
                    ('2026 Cycle'!$M$33:$M$1000<>"")*
                    ('2026 Cycle'!$K$33:$K$1000<>"")*
                    ('2026 Cycle'!$M$33:$M$1000>'2026 Cycle'!$K$33:$K$1000))

Delivered late   =SUMPRODUCT(('2026 Cycle'!$A$33:$A$1000<>"")*
                    ('2026 Cycle'!$N$33:$N$1000<>"")*
                    ('2026 Cycle'!$O$33:$O$1000<>"")*
                    ('2026 Cycle'!$N$33:$N$1000>'2026 Cycle'!$O$33:$O$1000))
```

**Keep these separate from the overdue counts and never add them together.** On the sample
tracker 22 orders ran late by one to five days. Folding those into "overdue" would leave the
account permanently red and hide the two orders that genuinely need a call today.

## 5 · Health

Assuming collections overdue in `B10`, deliveries overdue in `B11`, worst collection in `B12`:

```excel
=IF(OR(B11>0,B12>14),"AT RISK",IF(B10>0,"NEEDS ATTENTION","ON TRACK"))
```

Put the rule in a cell next to it, in words, so nobody has to reverse-engineer it:

> At risk when a delivery date has passed with no delivery recorded, or a collection is more
> than 14 days past. Needs attention when any collection date has passed unmet.

## 6 · Stage counts

```excel
Invoiced and closed  =COUNTIFS('2026 Cycle'!$A$33:$A$1000,"<>",'2026 Cycle'!$Y$33:$Y$1000,"<>")
Delivered            =COUNTIFS('2026 Cycle'!$A$33:$A$1000,"<>",'2026 Cycle'!$Y$33:$Y$1000,"",
                        '2026 Cycle'!$N$33:$N$1000,"<>")
In transit           =COUNTIFS('2026 Cycle'!$A$33:$A$1000,"<>",'2026 Cycle'!$Y$33:$Y$1000,"",
                        '2026 Cycle'!$N$33:$N$1000,"",'2026 Cycle'!$M$33:$M$1000,"<>")
Awaiting shipment    =COUNTIFS('2026 Cycle'!$A$33:$A$1000,"<>",'2026 Cycle'!$Y$33:$Y$1000,"",
                        '2026 Cycle'!$N$33:$N$1000,"",'2026 Cycle'!$M$33:$M$1000,"",
                        '2026 Cycle'!$J$33:$J$1000,"<>")
Open orders          =B20+B21+B22        (everything short of invoiced)
```

Each stage excludes the ones beyond it, so an order is counted exactly once.

---

## 7 · Upcoming collections and deliveries, by week or month

Two helper columns on the **2026 Cycle** sheet itself, in the first free columns — say `AB` and
`AC`. Put these in row 33 and fill down:

```excel
AB33  =IF(AND($A33<>"",$K33<>"",$M33=""),$K33,IF(AND($A33<>"",$O33<>"",$N33=""),$O33,""))
AC33  =IF(AB33="","",IF(AND($K33<>"",$M33=""),"Collection","Delivery"))
AD33  =IF(AB33="","",AB33-WEEKDAY(AB33,3))
AE33  =IF(AB33="","",EOMONTH(AB33,0))
```

`AB` is the next date this row is waiting on, `AC` says which kind, `AD` is the Monday of its
week, `AE` its month end.

> A row can be waiting on both a collection and a delivery. `AB` shows the collection while one
> is outstanding, then switches to the delivery once the goods move. That matches how the desk
> actually works — you chase the collection first.

Then **Insert → PivotTable** on the tracker range:

- **Rows:** `AD` (week) or `AE` (month) — this is the by-week / by-month switch
- **Rows, nested:** `AC` then `PO#`
- **Values:** count of `PO#`
- **Filter:** `AB` is not blank

Group the date field if Excel offers, or just sort it ascending. Add a slicer on `AC` to see
collections and deliveries apart.

**Sort descending to put the oldest overdue dates at the top**, or add a column
`=IF(AB33="","",IF(AB33<TODAY(),"OVERDUE","Upcoming"))` and put it above the date in the row
hierarchy — that reproduces the portal's behaviour of keeping missed dates in their own group
rather than buried in a past week.

---

## 8 · Conditional formatting

You mentioned you are colourblind, so none of these use colour alone.

| Range | Rule | Format |
| --- | --- | --- |
| Balance cells | Cell value `< 0` | Bold, dark red, **and** a custom number format `#,##0;"OVER "#,##0` so the word appears |
| Collection date `K` | Formula `=AND($K33<>"",$K33<TODAY(),$M33="")` | Red fill, **and** a left border 3pt |
| Delivery date `O` | Formula `=AND($O33<>"",$O33<TODAY(),$N33="")` | Red fill, **and** a double bottom border |
| Any date | Formula `=OR(YEAR(K33)<2000,YEAR(K33)>YEAR(TODAY())+3)` | Grey fill and the note "check this date" |

The border and the number format are the parts that survive being printed, photocopied, or read
by someone who cannot separate the fills. Set the format under **Home → Conditional Formatting →
New Rule → Use a formula**, and set the rule on the whole column range at once with the row
number **unlocked** (`$K33`, not `$K$33`).

Add a plain text key beside the table saying what each mark means. A legend nobody has to guess
at is worth more than any palette.
