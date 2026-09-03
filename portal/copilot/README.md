# Moving the Order Desk to Microsoft Copilot

For **Microsoft 365 Copilot Agent Builder**: a name, an instruction sheet, and SharePoint files
as knowledge.

> **If you have Copilot Studio, start at `skills/DEPLOY.md` instead.** Copilot Studio accepts
> skill upload, and `skills/` holds all three agents as uploadable `SKILL.md` files — one
> versioned definition each, rather than three instruction blocks pasted by hand. Steps 1, 2, 3,
> 5 and 6 below still apply; step 4 is replaced by the upload.

---

## Read this before you start

Agent Builder builds *declarative agents*: a prompt plus documents. It cannot run code, cannot
write to a file, and cannot call anything. That covers about half of what the portal does. The
other half has to move somewhere else, and pretending otherwise would waste your first week.

### What carries over well

| | |
| --- | --- |
| **Reading a PO and giving you the row** | Genuinely good. Your POs are text-based, the labels are consistent, and this is what language models are for. |
| **Drafting emails from templates** | Very good. Better than the portal at awkward one-offs, because you can just ask. |
| **Answering questions about a tracker** | Good for *finding* — "which POs have no collection date?" — and for explaining what a row means. |
| **Account summaries and chase emails** | Good. It writes better prose than the portal did. |

### What does not carry over

| | |
| --- | --- |
| **Writing to the tracking chart** | No agent can write to a file. The agent gives you the row; you paste it. See the paste procedure below — it matters, because the sheet's formulas break if you paste over them. |
| **The dashboard** | Agent Builder has no interface but chat. The dashboard moves into Excel as formulas — `excel-dashboard.md`. This is the right home for it anyway. |
| **Exact counts** | Copilot reads a spreadsheet as text and will miscount across many rows. Use it to find and explain; use Excel for numbers you act on. |
| **The `.msg` templates** | Copilot cannot read `.msg` or `.oft`. Convert them once — five minutes, below. |
| **Colourblind-safe stage patterns** | Chat has no charts. The Excel conditional formatting in `excel-dashboard.md` replaces them, using borders and number formats rather than colour alone. |

### The one that needs a decision

**The no-fabrication guarantee changes character.** The portal could not invent a value —
it read bytes out of a PDF and had nowhere to get a plausible-sounding number from. Copilot
*can* invent one. That is what a language model does when it has a gap.

The instruction sheets fight this hard: they define blank as the correct answer, require every
output to end with a list of what was blank, and require the arithmetic to be shown. In testing
that kind of instruction works most of the time. **Most of the time is a different guarantee
from never.**

What that means in practice: **the agent's output is a draft for a person to check, never
something to paste unread.** Build the habit now, while the batches are small. Check the PO
number, the quantity and the dates against the PDF every time — those three carry all the cost.

### On the security decision

Worth one sentence in case it is useful, then I will leave it: the portal made no network calls
of any kind and sent nothing anywhere — it ran from a file on your machine and touched only your
OneDrive folder. If the concern was data leaving the company, that is worth ten minutes with
whoever raised it, because Copilot sends your PO contents and tracker rows to Microsoft's
service, which is a larger surface, not a smaller one. If the concern was unsanctioned software,
that is a fair objection and Copilot is the right answer. Either way, what follows works.

---

## Step 1 · Lay out SharePoint

Copilot can only see SharePoint and OneDrive, and it inherits their permissions — people see
what they already have access to, and nothing else.

Make one document library, say **AMI Order Desk**, with this shape:

```
AMI Order Desk/
  Purchase orders/          the PO PDFs, as they arrive
  Tracking charts/          one workbook per item
  Templates/                vendor, trucker and customer templates
  Reference/                the constants sheet (see step 3)
```

Two things matter:

- **Keep folders small.** An agent pointed at a folder of 400 old POs answers worse than one
  pointed at 20 current ones. Move finished POs to an `Archive/` subfolder, and leave `Archive`
  out of the agent's knowledge.
- **One folder per purpose.** Give each agent only the folder it needs.

## Step 2 · Convert the templates

Copilot cannot open `.msg` or `.oft`. Once, for each template:

1. Open the `.msg` in Outlook.
2. **File → Save As → Save as type: HTML** (or paste the body into a Word document).
3. Save into `Templates/` as `.docx`, `.html` or `.txt`.
4. Name it for what it is: `Vendor - order placement.docx`, `Trucker - collection booking.docx`.
5. **Delete the trailing `Use: <account>` line** while you are in there.

Keep the placeholders exactly as they are — `{{vendorContact}}`, `{{poList}}` and so on. The
agent is told what each one means and where to get it.

## Step 3 · Put the per-item constants somewhere the agent can read

The arithmetic — bottles per case, cases per pallet, transit days — lives in the top-left block
of each tracking chart. Copilot reads that block unreliably.

Make one small file, `Reference/Item constants.docx`, with a line per item:

```
Evidencia Tempranillo Spain
  NAV code EVDTMPRNV · customer Aeromexico · supplier SAS Vins Beicher
  Bottles/case 12 · cs/pallet 48 · case weight 12.77 kg · full pallet 638 kg
  Production lead time 37 days · transit 2 days
  Collection: 1 route de Rodern, 68590 Saint Hippolyte, France
```

Add it to Agent 1 and Agent 2's knowledge. It is the highest-value file in the whole setup —
every calculated figure depends on it, and it is small enough to be read exactly.

> **On Copilot Studio**, skip this step: the constants are already inside
> `skills/ami-po-reader/SKILL.md`, in its **Item constants** table. Keep them in one place, not
> two — a second copy in SharePoint drifts and nobody knows which is right.

## Step 4 · Build the agents

In Microsoft 365 Copilot: **Create agent** (in Copilot chat, or the Copilot app in Teams).

For each of the three files in this folder:

1. **Configure** tab — do not use the Describe tab; it rewrites your instructions.
2. Paste the **Name** and **Description** from the file.
3. Paste everything between the ``` fences into **Instructions**. All of it, unedited.
4. **Knowledge → SharePoint** — add only the folders that file names.
5. Turn **Web search off**. There is nothing on the web these agents should use, and leaving it
   on invites answers from outside your documents.
6. Add the starter prompts from the table below.
7. **Create**, then **Share**.

| Agent | Knowledge | Starter prompts |
| --- | --- | --- |
| `AMI PO Reader` | `Purchase orders/`, `Reference/` | "Read the attached PO and give me the tracker row" · "What does this PO not tell me?" |
| `AMI Correspondence` | `Templates/`, `Purchase orders/`, `Reference/` | "Draft the vendor order email for PO 350633-2" · "Draft a collection booking for the trucker" |
| `AMI Order Desk Analyst` | `Tracking charts/` | "What is overdue on Aeromexico?" · "What is due in the next two weeks?" · "Where does the contract stand?" |

Turn **Code interpreter on** for the Analyst if your tenant offers it — it makes counting far
more reliable, because it computes rather than reads.

## Step 5 · The paste procedure

This is the step where the tracker gets broken, so it is worth doing the same way every time.

The agent gives you a row. **Four columns carry formulas and must not be typed over:**

| | |
| --- | --- |
| `I` | ORDERS MUST BE SEND TO WINERY PRIOR TO |
| `K` | AMI Requested Collection Date |
| `S` | Balance on Contract (bt) |
| `T` | Balance on Contract (cs) |

Those four compute themselves from the row and from the row above. Typing a value into `S`
breaks the running balance for **every row beneath it**, and nothing warns you.

So:

1. Select the whole previous row and **drag the fill handle down one row**. That carries all
   four formulas into the new row, correctly shifted.
2. Now type the agent's values into the remaining cells, leaving `I`, `K`, `S` and `T` alone.
3. Check `S` recalculated to the previous balance minus this order's bottles.
4. Check the PO number, quantity and dates against the PDF.

If you would rather paste a whole row: paste into a **blank scratch sheet** first, then copy
across only the cells you need. Never paste a full row over the live one.

## Step 6 · The dashboard

Follow `excel-dashboard.md`. It is a sheet of formulas per workbook — half an hour once, and
then the numbers are exact and recalculate themselves.

Do this before you rely on the Analyst agent for anything you would act on. The agent is for
finding and explaining; the formulas are the authority.

---

## Testing it before you trust it

Run these three on day one, against a PO you have already posted by hand, so you know the answer:

1. **Give Agent 1 a PO and compare every cell** to the row you posted. Anything that differs is
   either a real find or a hallucination — either way you want to know which on day one, not in
   month two.
2. **Ask Agent 1 for a field the PO does not carry** — a bottling date, say. It must answer
   BLANK and list it. If it produces a date, the instructions are not taking; re-paste them and
   check nothing was truncated.
3. **Ask Agent 2 to draft to an airport city with two airports** — "delivery to London". It must
   list the options and ask, not pick one.

If any of those three fails, stop and fix it before rolling the agents out to anyone else. They
are the three failures that cost real money.

## What to keep from the old project

The repository stays useful even with the portal decommissioned:

- `portal/README-Teams.md` — how the workflow actually runs, in detail. The agents encode a
  compressed version; this is the long form.
- `portal/src/status.js` — the stage, contract and lateness rules as executable definitions.
  When someone asks "what exactly counts as overdue", this is the answer.
- `portal/src/airports.js` — the airport table, including which cities have several.
- `portal/src/engine.js` — the PO field labels and tracker arithmetic.

If Copilot Studio is ever approved, that code is the specification for a proper connector, and
the deterministic parts could go back to being deterministic.
