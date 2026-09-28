# Global Wine Operations Hub — Product & Architecture Design

> **Design principle:** *Comprehensive enough to run global operations, simple enough that a new operations coordinator can learn it in one day.*

This document is the product, UX, and technical blueprint for the Global Wine Operations Hub (GWOH): the single operational workspace for the Global Wine Operations team that manages airline, distributor, and hospitality accounts worldwide.

---

## Contents

0. [Design Foundations](#0-design-foundations)
1. [Information Architecture](#1-information-architecture)
2. [User Personas, Roles & Permissions](#2-user-personas-roles--permissions)
3. [Wireframe Descriptions](#3-wireframe-descriptions)
4. [Database Schema](#4-database-schema)
5. [Workflow Engine Design](#5-workflow-engine-design)
6. [Exception Framework](#6-exception-framework)
7. [Dashboard Designs](#7-dashboard-designs)
8. [Technology Architecture & Microsoft Integrations](#8-technology-architecture--microsoft-integrations)
9. [Recommended MVP](#9-recommended-mvp)
10. [Future Enhancements (AI)](#10-future-enhancements-ai)
11. [Appendix: Stage Checklists & Default Rules](#11-appendix-stage-checklists--default-rules)

---

## 0. Design Foundations

### 0.1 The five rules every screen must obey

| # | Rule | What it means in practice |
|---|------|---------------------------|
| 1 | **The system does the paperwork** | Tasks, folders, requirement checklists, reminders and exceptions are *generated*, not typed. Users confirm, they don't compose. |
| 2 | **Exceptions float, normal work sinks** | Anything on track is quiet (grey/green). Anything late, missing or wrong is loud (amber/red) and sorted to the top. |
| 3 | **One order, one page** | Everything about an order — status, tasks, documents, emails, shipment, exceptions, money — lives on a single scrollable page. No sub-apps. |
| 4 | **Two clicks to anything** | Global search (`/` or `Ctrl+K`) reaches any order, PO, container, customer, supplier or document. Every list row opens its record in a side panel without leaving the list. |
| 5 | **Every item has an owner and a date** | No task, exception or stage exists without a named person and a due date. "Unowned" is itself an exception. |

### 0.2 The operating model in one sentence

An **Order** moves through **12 Stages**; each stage auto-generates a short **Checklist of Tasks**; completing the checklist produces the stage's **Output** and advances the order; anything that blocks progress becomes an **Exception** with an owner, severity and due date.

### 0.3 Core objects (the whole mental model)

```
Account ──< Order ──< Order Line
              │
              ├──< Stage Instance ──< Task
              ├──< Exception
              ├──< Document (versions)
              ├──< Shipment ──< Tracking Event
              ├──< Supplier PO ──< Supplier Invoice
              ├──< Customer Invoice
              └──< Activity (timeline: emails, comments, status changes)
```

A new coordinator needs to learn only these seven words: **Order, Stage, Task, Exception, Document, Shipment, Account.**

### 0.4 Stage model with "gates"

Stages are grouped into four **phases** so the progress bar stays readable on a phone:

| Phase | Stages | Gate (output that advances the order) |
|-------|--------|----------------------------------------|
| **A. Commit** | 1 PO Intake · 2 Order Validation · 3 Supplier Release | Supplier committed |
| **B. Prepare** | 4 Supply Coordination · 5 Logistics Planning · 6 Documentation · 7 Pre-Shipment Review | Shipment approved |
| **C. Move** | 8 Shipment Execution · 9 Delivery Management | Delivery complete |
| **D. Close** | 10 Customer Invoicing · 11 Supplier Settlement · 12 Order Closure | Order closed |

Stages 4–6 may run **in parallel** (supply, logistics and documents are worked simultaneously in reality); the engine allows this, and Stage 7 is the convergence gate. Stages 10 and 11 likewise run in parallel.

---

## 1. Information Architecture

### 1.1 Site map

```
Global Wine Operations Hub
│
├── 🏠 My Work  (default landing page)
│     ├── Needs my action (tasks + exceptions, one merged list)
│     ├── Upcoming milestones (next 14 days)
│     ├── My orders (compact board)
│     └── Following / @mentions
│
├── 📦 Orders
│     ├── Order list (saved views: My orders · Team · Late · At risk · Awaiting invoice · Closed)
│     ├── Board view (orders as cards in stage columns)
│     └── Order page  ← single source of truth
│           ├── Summary header
│           ├── Workflow tracker
│           ├── "Next up" checklist (current stage tasks)
│           ├── Exceptions (if any)
│           ├── Lines & Requirements
│           ├── Shipment
│           ├── Documents
│           ├── Financials
│           ├── Stakeholders
│           └── Activity timeline
│
├── ✅ Tasks
│     ├── My tasks · Team tasks · Overdue · Unassigned
│     └── (List + calendar toggle)
│
├── ⚠️ Exceptions
│     ├── Open (by severity) · Mine · Escalated · Resolved (30 days)
│     └── Exception detail (side panel)
│
├── 🚚 Shipments
│     ├── In transit · Collecting this week · Arriving this week · Delayed
│     └── Shipment detail (visual timeline + map)
│
├── 📄 Documents
│     ├── Search across all documents
│     └── Missing documents view
│
├── 🏢 Accounts
│     ├── Account list
│     └── Account profile
│           ├── Overview (info, destinations, contacts)
│           ├── Requirements Library
│           ├── Orders & performance
│           └── Notes
│
├── 🏭 Partners  (Suppliers, Forwarders, Warehouses, Brokers)
│     └── Partner profile (contacts, performance, open orders)
│
├── 📊 Insights
│     ├── Executive Dashboard
│     ├── Operational Performance
│     ├── Financial Metrics
│     └── Supplier Performance
│
└── ⚙️ Admin  (visible only to Admin role)
      ├── Users & roles
      ├── Workflow templates (stage checklists, SLAs)
      ├── Exception rules
      └── Integrations
```

### 1.2 Navigation model

**Primary navigation = left rail with 4 "daily" items + 4 "reference" items.** No nested menus, no hover flyouts.

```
┌──────┐
│ 🍷   │  ← logo / home
│──────│
│ 🏠   │  My Work        ┐
│ 📦   │  Orders         │ Daily (90% of time)
│ ✅   │  Tasks          │
│ ⚠️ 7 │  Exceptions     ┘ ← live badge count (red if any Critical)
│──────│
│ 🚚   │  Shipments      ┐
│ 📄   │  Documents      │ Reference
│ 🏢   │  Accounts       │
│ 📊   │  Insights       ┘
│      │
│ ⚙️   │  Admin (role-gated)
│ 👤   │  Profile / notifications
└──────┘
```

**Global elements present on every screen:**

| Element | Behaviour |
|---------|-----------|
| **Command bar** (`Ctrl+K` / `/`) | Search orders, PO #s, supplier POs, container/AWB #s, customers, documents (full-text), people. Also runs actions: "new order", "go to exceptions", "assign to…". |
| **+ New** button | Only four things can be created manually: Order, Exception, Task (ad-hoc), Comment. |
| **Notification bell** | Mentions, assignments, escalations. Mirrors to Teams. |
| **Side-panel pattern** | Clicking any row in any list opens the record in a right-hand drawer. `Enter` expands to full page; `Esc` closes. Keeps context; eliminates back-button navigation. |

**Depth limit:** Maximum depth is **2 levels** (List → Record). Everything inside a record is on one scrollable page with an anchored mini-nav, never tabs-within-tabs.

### 1.3 Mobile model

Mobile is for **review and quick action**, not data entry.

| Mobile screen | Actions allowed |
|---------------|-----------------|
| My Work | Complete task, snooze, reassign, comment |
| Exceptions | Acknowledge, comment, escalate, resolve |
| Order page (condensed) | View status, timeline, documents (preview), call/email a stakeholder |
| Shipment | View timeline and ETA |
| Approvals | Approve / reject order validation, pre-shipment review, invoice |

Bottom tab bar on mobile: **My Work · Orders · Exceptions · Search**.

---

## 2. User Personas, Roles & Permissions

### 2.1 Personas

| Persona | Who | Goals | Pain today | What GWOH gives them |
|---------|-----|-------|-----------|----------------------|
| **Olivia — Operations Coordinator** (primary) | Runs 80–150 active orders across 6–10 accounts | Never miss a step, never be surprised | Lives in Outlook + Excel trackers; hunts for documents; forgets account quirks | My Work queue; auto-checklists; requirements surfaced automatically; one-click email from order |
| **Marco — Senior Ops Specialist / Account Lead** | Owns strategic accounts (e.g. an airline) | Protect the account; handle escalations | No single view of an account's health | Account profile with performance, exceptions and requirements; escalation inbox |
| **Hannah — Operations Manager** | Leads a team of 6–12 | Balance workload, see risks early, report up | Asks people for status in meetings | Team views, workload heatmap, exception board, one-click reassign |
| **David — Director / VP Operations** (executive) | Leadership | Revenue flow, service level, risk | Monthly spreadsheets, late news | Executive dashboard; weekly digest in Teams/email |
| **Fatima — Finance / AR-AP Analyst** | Invoicing & supplier payment | Bill accurately and fast; pay against valid docs | Chases ops for POD and prices | "Ready to invoice" queue; invoice validation against PO; supplier invoice match |
| **Sam — Sales / Account Manager** | Commercial owner of the customer | Know order status without asking ops | Emails ops constantly | Read-only order/account view; Copilot status answers; subscribe to an order |
| **External Partner** (Phase 3) | Supplier, forwarder, broker | Upload docs, confirm dates | Email ping-pong | Secure upload link / light partner portal |

### 2.2 Roles

Roles are **few and additive**. Access is additionally scoped by **Region** and optionally **Account**.

| Role | Summary |
|------|---------|
| **Viewer** | Read-only (Sales, other stakeholders). |
| **Coordinator** | Works orders: complete tasks, upload documents, raise/resolve exceptions, edit order data in own scope. |
| **Specialist** | Coordinator + edit account Requirements Library, approve Stage 2 & 7 gates for own accounts. |
| **Manager** | Specialist + reassign anyone in team, override gates, close Critical exceptions, see team workload. |
| **Finance** | Viewer on ops data + full control of Stages 10–11 (invoices, supplier settlement). |
| **Executive** | Viewer across all regions + Insights. |
| **Admin** | Users, roles, workflow templates, exception rules, integrations. No automatic business approvals. |
| **Partner (external)** | Upload/confirm only on orders they are linked to, via tokenised links. |

### 2.3 Permission matrix

| Capability | Viewer | Coord. | Spec. | Mgr | Finance | Exec | Admin |
|-----------|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| View orders (in scope) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ all | ✅ |
| Create order / capture PO | – | ✅ | ✅ | ✅ | – | – | – |
| Complete / reassign own tasks | – | ✅ | ✅ | ✅ | ✅ (10–11) | – | – |
| Reassign others' tasks | – | – | own accts | ✅ | – | – | – |
| Approve Stage 2 (validation) | – | –¹ | ✅ | ✅ | – | – | – |
| Approve Stage 7 (pre-shipment) | – | –¹ | ✅ | ✅ | – | – | – |
| Raise exception | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | – |
| Close Critical exception | – | – | – | ✅ | – | – | – |
| Edit Requirements Library | – | suggest | ✅ | ✅ | – | – | – |
| Create/issue customer invoice | – | – | – | – | ✅ | – | – |
| Approve supplier payment | – | – | – | ✅ (≤ limit) | ✅ | – | – |
| View financial metrics | – | own orders | ✅ | ✅ | ✅ | ✅ | – |
| Manage workflow templates & rules | – | – | – | propose | – | – | ✅ |

¹ Configurable per account: low-risk accounts can allow coordinator self-approval with an audit record.

**Implementation:** Entra ID (Azure AD) security groups map to roles; row-level scoping via `region_id` / `account_id` enforced in the API layer and database (Row-Level Security).

---

## 3. Wireframe Descriptions

Visual language: white canvas, one neutral grey sidebar, a single brand accent (deep burgundy `#7B1E3A`) for primary actions, status colours reserved strictly for status:

| Colour | Meaning |
|--------|---------|
| 🟢 Green | On track / complete |
| 🔵 Blue | In progress / informational |
| 🟡 Amber | At risk / due within 48h / Medium exception |
| 🔴 Red | Late / blocked / High or Critical exception |
| ⚪ Grey | Not started / not applicable |

Typography: one sans-serif family (e.g. Segoe UI / Inter), 14px body, tabular numerals for all figures. Density toggle (Comfortable / Compact) for power users with 200 orders.

---

### 3.1 My Work (default landing page)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ [Ctrl+K  Search orders, POs, containers, documents…]          [+ New]  🔔 3  👤 │
├─────────────────────────────────────────────────────────────────────────────────┤
│ Good morning, Olivia.  You have 6 things due today, 2 overdue, 1 escalation.   │
│                                                                                 │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐               │
│ │ OVERDUE  │ │ DUE TODAY│ │ MY OPEN  │ │ MY ORDERS│ │ESCALATED │               │
│ │   🔴 2   │ │   🟡 6   │ │EXCEPTIONS│ │  AT RISK │ │  TO ME   │               │
│ │          │ │          │ │   🔴 3   │ │   🟡 4   │ │   🔴 1   │               │
│ └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘               │
│  (each card is a filter for the list below)                                     │
│                                                                                 │
│ NEEDS MY ACTION                                 [Group: Due ▾] [Compact ◻]      │
│ ─────────────────────────────────────────────────────────────────────────────── │
│ 🔴 EXC  Missing phyto certificate   SO-24118 · SkyAir · Stage 6   Due yesterday │
│         [Request from supplier ✉]  [Upload]  [Snooze ▾]                        │
│ 🔴 TASK Confirm supplier acceptance SO-24102 · Harbor Dist · St 3  Overdue 1d   │
│         [Mark done ✓]  [Send reminder ✉]                                       │
│ 🟡 TASK Validate pricing vs contract SO-24131 · Grand Hotels · St 2  Today      │
│         [Open side panel →]                                                     │
│ 🔵 TASK Book collection              SO-24097 · SkyAir · St 5      Tomorrow     │
│ …                                                                               │
│                                                                                 │
│ ┌──────────────────── UPCOMING MILESTONES (14 days) ─────────────────────────┐  │
│ │ Mon 30  ● ETD SO-24097 (Le Havre)   ● Collection SO-24110                  │  │
│ │ Tue 01  ● Customer delivery due SO-24088                                   │  │
│ │ Thu 03  ● ETA SO-24075 (SIN)   ● Invoice due SO-24061                      │  │
│ └────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
│ MY ORDERS BY PHASE      Commit (18) ▓▓▓  Prepare (41) ▓▓▓▓▓▓  Move (22) ▓▓▓▓   │
│                         Close (14) ▓▓                                          │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**Behaviour**
- Tasks and exceptions are merged into **one prioritised list** (ranking: severity → overdue → due date → order value).
- **Inline actions** on each row are the 1–2 most likely next steps for that task type (defined in the task template), so most work is completed without opening the order.
- "Mark done" on a task that needs evidence (e.g. upload a document) prompts for it inline.
- **Snooze** requires a reason and a new date; snoozing past the stage SLA auto-flags the order at risk.
- Manager variant adds a **Team** toggle and a workload strip (open tasks per person, coloured by overdue count).

---

### 3.2 Orders — List & Board

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ Orders   [My orders] [Team] [Late 🔴9] [At risk 🟡14] [Awaiting invoice 12] [+View]│
│ Filters: Account ▾  Region ▾  Stage ▾  Owner ▾  Ship window ▾      [List|Board] │
├─────────────────────────────────────────────────────────────────────────────────┤
│ ● │ Order    │ Customer / PO        │ Stage            │ Owner │ Req. del. │ Value│ ⚠ │
│ 🔴│ SO-24118 │ SkyAir · PO 889213   │ 6 Documentation  │ OP    │ 12 Oct    │ €84k │ 2 │
│ 🟡│ SO-24131 │ Grand Hotels · 5521  │ 2 Validation     │ OP    │ 20 Oct    │ €22k │ 1 │
│ 🟢│ SO-24097 │ SkyAir · PO 889101   │ 5 Logistics      │ OP    │ 18 Oct    │€140k │ – │
└─────────────────────────────────────────────────────────────────────────────────┘
```

- **Health dot** (left) = worst of: stage SLA, open exceptions, requested delivery date risk.
- Stage column shows a **mini 12-segment bar** on hover.
- **Bulk actions**: reassign owner, add follower, export to Excel.
- **Board view**: columns = phases (Commit / Prepare / Move / Close) with cards; drag is *not* used to change stage (stages advance by completing gates) — the board is for visibility only, preventing accidental status changes.
- Saved views are personal or shared; the team's standard views are pinned by the Manager.

---

### 3.3 Order Page (single source of truth)

One scrollable page; sticky header; anchored mini-nav on the right (`Summary · Next up · Exceptions · Lines · Shipment · Documents · Financials · People · Activity`).

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ ← Orders   SO-24118                                         [Follow] [⋯ More]   │
│ ┌─────────────────────────────────────────────────────────────────────────────┐ │
│ │ SkyAir International  ·  Account: SkyAir – Business Class Program            │ │
│ │ Customer PO 889213  ·  Supplier PO SP-7741 (Domaine Laurent)                 │ │
│ │ Status: 🔴 At risk – documentation      Owner: Olivia P.  Backup: Marco R.    │ │
│ │ Requested delivery 12 Oct · Ship by 02 Oct · Invoice by 20 Oct                │ │
│ │ Value €84,200 · 1,440 btl · 120 cs · Incoterm FCA Beaune · Dest. SIN hub     │ │
│ │ [✉ Email stakeholders] [💬 Teams chat] [📁 Open folder] [+ Exception]         │ │
│ └─────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
│ WORKFLOW                                                                        │
│  COMMIT ─────────────── PREPARE ─────────────────────── MOVE ─────── CLOSE      │
│  (1)✓ (2)✓ (3)✓       (4)✓ (5)● (6)🔴 (7)○             (8)○ (9)○    (10)○(11)○(12)○│
│                        Supply  Logist. Docs  Pre-ship                            │
│  Hover any stage: owner, dates entered/completed, SLA, task count.              │
│                                                                                 │
│ NEXT UP — Stage 6 Documentation (3 of 7 done)                     SLA: 1d left  │
│  ☑ Commercial invoice drafted              auto · 26 Sep                        │
│  ☑ Packing list received                   Domaine Laurent · 26 Sep             │
│  ☐ Phytosanitary certificate    🔴 overdue  [Request ✉] [Upload]               │
│  ☐ Certificate of origin (EUR.1)            [Request ✉] [Upload]               │
│  ☐ Airline label proof approved ★ account rule  [Upload] [Mark approved]       │
│  ☐ Validate docs vs account rules           (unlocks when all uploaded)         │
│                                                                                 │
│ EXCEPTIONS (2 open)                                                              │
│  🔴 HIGH  Missing phyto cert · Owner Olivia · Due 29 Sep · Supplier non-resp.    │
│  🟡 MED   Price variance 1.8% line 3 vs contract · Owner Fatima · Due 02 Oct     │
│                                                                                 │
│ ACCOUNT REQUIREMENTS THAT APPLY (auto-surfaced, 6)                  [View all]  │
│  ★ Labels: airline-specific back label with lot code (Label rule L-03)          │
│  ★ Packing: max 12 btl/case, dividers, cases ≤ 18 kg (P-01)                     │
│  ★ Docs: commercial invoice must show HS 2204.21 & airline PO (D-02)             │
│  ★ Invoice: separate invoice per delivery hub (I-01)                            │
│                                                                                 │
│ ORDER LINES                                                                      │
│  # SKU      Wine                        Vintage Qty(btl) Price   Avail  Alloc   │
│  1 DL-MRS   Meursault 1er Cru           2022    480     €62.00  ✓      ✓       │
│  2 …                                                                              │
│                                                                                 │
│ SHIPMENT   Air · Forwarder: GlobalFreight · Collection 01 Oct · ETD 02 Oct CDG   │
│            ETA 03 Oct SIN · Status: Booked   [Open shipment →]                   │
│            ●───────●───────○───────○───────○                                     │
│          Booked  Collected Departed Arrived Delivered                            │
│                                                                                 │
│ DOCUMENTS (9)  Customer PO v1 · Supplier PO v2 · Packing list v1 · CI draft v3 … │
│             Missing: Phyto, EUR.1, POD  [Upload] [Open SharePoint folder]         │
│                                                                                 │
│ FINANCIALS  Order €84,200 · Cost €61,900 · Margin 26.5%                          │
│             Customer invoice: not yet · Supplier invoice: not yet                │
│                                                                                 │
│ STAKEHOLDERS                                                                     │
│  Customer   J. Tan (Procurement, SkyAir) ✉ ☎ · Hub receiving SIN ✉              │
│  Supplier   C. Laurent (Export mgr) ✉ ☎                                          │
│  Logistics  GlobalFreight CDG desk ✉ · Broker: SG Customs Co ✉                   │
│  Internal   Olivia (owner) · Marco (backup) · Fatima (finance) · Sam (sales)     │
│                                                                                 │
│ ACTIVITY                    [All] [Emails] [Docs] [Comments] [Status] [Tasks]   │
│  [ Write a comment… @mention to notify                               ] [Post]  │
│  28 Sep 09:14  ✉ Email from C. Laurent: "phyto inspection booked Tue" (Outlook) │
│  27 Sep 16:02  ⚠ Exception raised automatically: Missing phyto cert             │
│  26 Sep 11:30  📄 Packing list v1 uploaded by supplier link                      │
│  25 Sep 08:00  ➜ Stage 5 & 6 started (auto, after supply confirmed)             │
│  …                                                                               │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**Design decisions**
- **"Next up" sits above everything else** because it answers the only question that matters: *what has to happen next on this order?*
- **Account requirements are shown on the order**, not hidden in the account profile, and each is linked to the task that verifies it.
- Inline editing of header fields (click to edit, auto-save, audit logged). No "Edit mode" and no Save button.
- `⋯ More` holds rare actions: split order, cancel, put on hold, clone, change owner, print pack.

---

### 3.4 New Order / PO Intake

Designed to take **< 3 minutes** for a standard PO.

```
┌──────────────────────── New order ────────────────────────┐
│ 1. Drop the customer PO here (PDF, Excel, email .msg)      │
│    [ ⬇ drag & drop ]   or  [Paste from email]              │
│                                                            │
│ 2. Confirm details (pre-filled where possible)             │
│    Customer  [SkyAir ▾]   Account [Business Class ▾]       │
│    PO #      [889213 ]    PO date [24 Sep]                 │
│    Deliver to [SIN hub ▾] (from account destinations)      │
│    Requested delivery [12 Oct]                             │
│    Lines: [paste from Excel] or table below (SKU lookup)   │
│                                                            │
│ 3. Checks run automatically                                │
│    ✓ Prices match contract price list (2026)               │
│    ⚠ Line 3 quantity exceeds allocation by 60 btl          │
│    ✓ Lead time OK (18 days vs 14-day minimum)              │
│    ★ 6 account requirements will be attached               │
│                                                            │
│             [Cancel]   [Create order & accept for review]  │
└────────────────────────────────────────────────────────────┘
```

On create the system automatically: assigns order number; assigns owner (account default owner); creates the SharePoint order folder and files the PO as v1; attaches account requirements; generates Stage 1 & 2 tasks; converts failed checks into exceptions; posts to the account's Teams channel (optional); logs "Order accepted for review".

---

### 3.5 Tasks

Simple list with the same row pattern as My Work. Views: **My tasks · Team · Overdue · Unassigned · Completed**. Toggle to **calendar** (by due date). Filters: stage, account, priority, order. Bulk: reassign, change due date (with reason). Ad-hoc task creation is available but secondary; every ad-hoc task must link to an order or account.

---

### 3.6 Exceptions

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ Exceptions   [Open 23] [Mine 5] [Escalated 3] [Unowned 1] [Resolved 30d]       │
│                                                                                 │
│  CRITICAL (1)  ─────────────────────────────────────────────────────────────── │
│  🟥 Shipment delayed >72h, delivery date will be missed                         │
│     SO-24075 · SkyAir · Owner Marco · Due today · Escalated to Hannah (L2)       │
│  HIGH (6)  ─────────────────────────────────────────────────────────────────── │
│  🔴 Missing phyto cert · SO-24118 · Olivia · Due 29 Sep · Age 1d · Acknowledged │
│  🔴 Supplier non-response 48h · SO-24102 · Olivia · Due today · Open            │
│  MEDIUM (11) … LOW (5) …                                                        │
│                                                                                 │
│  Chart strip: Open by type ▮▮▮▮  · Avg age 2.1d · Oldest 9d · SLA breach 3       │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**Exception side panel:** title, type, severity, order link, owner, due date, status, impact (delivery / revenue / compliance), root cause (on resolve), suggested actions (from the exception type playbook), linked tasks, discussion thread, escalation history. Buttons: **Acknowledge · Add action · Escalate · Resolve · Reassign**.

---

### 3.7 Shipments

List views: **Collecting this week · In transit · Arriving this week · Delayed · Delivered (awaiting POD)**.

Shipment detail:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ SHP-3312 · Air · GlobalFreight · AWB 057-1234 5675 · SO-24097, SO-24110          │
│ Status: 🟢 In transit                   ETA 03 Oct 06:40 SIN (orig. 03 Oct 06:40)│
│                                                                                 │
│   Booked      Collected      Departed      Arrived      Customs      Delivered  │
│   ●───────────●──────────────●─────────────○────────────○────────────○          │
│  24 Sep      01 Oct         02 Oct 22:10   03 Oct(ETA)                          │
│  planned vs actual shown for every milestone; variance > threshold = amber/red  │
│                                                                                 │
│ Collection 01 Oct (Beaune warehouse)  · ETD 02 Oct CDG · ETA 03 Oct SIN          │
│ Delivery status: Not delivered · POD: pending                                   │
│ Pallets 4 · Gross 1,690 kg · Temp-controlled ✓ (reefer / ≤ 18°C)                 │
│ Map (optional): origin → current → destination                                  │
│ Tracking events (latest first) … source: forwarder API / email / manual          │
└─────────────────────────────────────────────────────────────────────────────────┘
```

A shipment can carry several orders (consolidation); an order can have several shipments (split). ETA changes beyond tolerance automatically raise a *Delayed shipment* exception on each affected order.

---

### 3.8 Document Center

- **Search** across filename, type, order, account, and full-text (OCR'd) content.
- Left filter rail: document type (PO, Supplier PO, Packing List, Commercial Invoice, Certificates, B/L-AWB, Customs, POD, Other), account, date, status (Draft / Under review / Approved / Superseded).
- **Preview pane** (PDF/Office inline) with version history on the right: `v3 (current) · v2 · v1`, who uploaded, when, and a "compare" option for Office files.
- **Missing documents view**: matrix of orders × required doc types, with ✓ / ⚠ / ✗ — driven by the account + destination requirements.
- Upload anywhere (order page, Document Center, email forward, partner link); auto-classification suggests the document type.

---

### 3.9 Account Profile

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ SkyAir International — Business Class Program       Health: 🟡  Owner: Marco R.  │
│ Airline · APAC · Customer since 2019 · Payment terms 45d · Currency EUR          │
│ KPIs (12 mo): Orders 146 · OTIF 94% · Exceptions/order 0.6 · Revenue €4.2M        │
│                                                                                 │
│ OVERVIEW                                                                        │
│  Legal entity & billing address · VAT/Tax IDs · Contract & price list (v2026)    │
│  Destinations: SIN hub · HKG hub · LHR hub (each with receiving hours,           │
│                importer of record, customs broker, required docs)                │
│  Contacts: procurement, receiving, AP, quality — with roles                      │
│                                                                                 │
│ REQUIREMENTS LIBRARY                                   [+ Add requirement]       │
│  Category   Rule                                     Applies to     Verified by  │
│  Label      Back label with lot code & airline logo  All orders     Stage 6 task │
│  Docs       CI must show HS code & airline PO #      All orders     Stage 6 task │
│  Packing    ≤ 12 btl/case, dividers, ≤ 18 kg         All orders     Stage 7 task │
│  Shipping   Temp-controlled Jun–Sep                  Months 6–9     Stage 5 task │
│  Invoice    One invoice per delivery hub             All orders     Stage 10 task│
│  Compliance Halal-free cert not required; FDA n/a     Dest = SIN     —          │
│                                                                                 │
│ ORDERS & PERFORMANCE  (open orders table, trend charts)                         │
│ NOTES  (pinned lessons learned from closed orders)                              │
└─────────────────────────────────────────────────────────────────────────────────┘
```

Each requirement has: category, rule text, **conditions** (destination, product type, month, order value, transport mode), **verification** (which stage/task checks it), attachments (e.g. label template), owner, effective dates, and version history.

---

### 3.10 Insights

Four dashboards (see §7 for the Executive design), each a single page with filter bar (date range, region, account, owner). Every chart is **clickable to the underlying list** — reporting is a navigation aid, not a dead end. "Export to Excel" and "Open in Power BI" on each.

---

## 4. Database Schema

**Engine:** Azure SQL Database (relational integrity for orders/finance; Row-Level Security for scoping). Documents stored in SharePoint; only metadata in SQL. All tables carry `created_at, created_by, updated_at, updated_by`; soft delete via `is_active` / `deleted_at`. Surrogate keys `id` (UUID or BIGINT identity).

### 4.1 Entity-relationship overview

```
                     ┌────────────┐
                     │  region    │
                     └─────┬──────┘
                           │
┌──────────┐   ┌───────────┴──────────┐     ┌──────────────────┐
│ customer │──<│      account         │──<  │ account_requirement│
└──────────┘   └──┬──────────┬────────┘     └──────────────────┘
                  │          │
       ┌──────────┘          └───────┐
┌──────┴──────┐              ┌───────┴──────────┐
│ destination │              │ account_contact  │→ contact
└──────┬──────┘              └──────────────────┘
       │
┌──────┴──────────────────────────────────────────────────────────────┐
│                               order                                  │
└─┬──────┬───────┬────────┬────────┬─────────┬─────────┬──────────┬───┘
  │      │       │        │        │         │         │          │
order_  stage_  task   exception document  order_   supplier_  customer_
line    instance              (→doc_version) shipment  po          invoice
  │                                            │        │
product                                    shipment  supplier_invoice
                                               │
                                        tracking_event
  order_requirement (snapshot of applicable account_requirement)
  activity (timeline — polymorphic)
  order_stakeholder (→ contact | app_user)
```

### 4.2 Tables

#### Reference & people

| Table | Key columns | Notes |
|-------|-------------|-------|
| `region` | id, code, name, timezone | EMEA, APAC, AMER… |
| `app_user` | id, entra_object_id, name, email, role, region_id, manager_id, is_active | Role cached from Entra group sync |
| `user_account_scope` | user_id, account_id | Optional account-level scoping |
| `customer` | id, name, type (`airline`/`distributor`/`hospitality`), bc_customer_no, region_id | `bc_customer_no` links to Business Central |
| `account` | id, customer_id, name, owner_user_id, backup_user_id, region_id, currency, payment_terms_days, incoterm_default, price_list_id, risk_tier, approval_mode, teams_channel_id, sharepoint_site_url | Account = commercial program under a customer |
| `destination` | id, account_id, name, address, country, port_code, receiving_hours, importer_of_record, customs_broker_partner_id, transport_mode_default | |
| `partner` | id, name, type (`supplier`/`forwarder`/`warehouse`/`customs_broker`), bc_vendor_no, country, region_id | Suppliers/wineries and service providers |
| `contact` | id, first_name, last_name, email, phone, title, customer_id NULL, partner_id NULL | One contact table for all external people |
| `account_contact` | account_id, contact_id, role (`procurement`/`receiving`/`AP`/`quality`), is_primary | |
| `product` | id, sku, name, producer_partner_id, vintage, colour, size_ml, bottles_per_case, hs_code, abv, bc_item_no | |
| `price_list` / `price_list_line` | id, account_id, valid_from, valid_to / price_list_id, product_id, unit_price, currency, min_qty | Used for automatic price validation |

#### Requirements

| Table | Key columns | Notes |
|-------|-------------|-------|
| `account_requirement` | id, account_id, category (`label`/`documentation`/`packing`/`shipping`/`invoice`/`compliance`), title, rule_text, conditions_json, verify_stage_no, verify_task_template_id, severity_if_missed, attachment_url, effective_from, effective_to, version, owner_user_id | `conditions_json` e.g. `{"destination_country":["SG"],"months":[6,7,8,9]}` |
| `destination_requirement` | id, country, category, rule_text, required_doc_type_id, conditions_json | Country/regulatory rules (e.g. US TTB/FDA prior notice, certificate of origin) |
| `order_requirement` | id, order_id, source (`account`/`destination`), source_requirement_id, source_version, rule_text_snapshot, status (`pending`/`verified`/`waived`/`failed`), verified_by, verified_at, waiver_reason | **Snapshot** so later rule edits don't alter historical orders |

#### Orders

| Table | Key columns | Notes |
|-------|-------------|-------|
| `order` | id, order_no, account_id, destination_id, customer_po_no, customer_po_date, owner_user_id, backup_user_id, status (see §5.1), current_phase, health (`green`/`amber`/`red`), requested_delivery_date, ship_by_date, promised_delivery_date, incoterm, transport_mode, currency, order_value, cost_value, on_hold, hold_reason, sharepoint_folder_url, bc_sales_order_no, source (`manual`/`email`/`upload`/`edi`), closed_at | `health` is computed by the engine and stored for fast list queries |
| `order_line` | id, order_id, line_no, product_id, quantity_bottles, unit_price, contract_price, price_variance_pct, availability_status, allocated_qty, supplier_po_line_id | |
| `order_stakeholder` | id, order_id, contact_id NULL, user_id NULL, role (`customer`/`supplier`/`logistics`/`broker`/`internal_owner`/`finance`/`sales`/`follower`) | |
| `order_tag` | order_id, tag | e.g. "Peak season", "VIP" |

#### Workflow

| Table | Key columns | Notes |
|-------|-------------|-------|
| `workflow_template` | id, name, version, is_default, account_id NULL | Default + optional account-specific variants |
| `stage_definition` | id, workflow_template_id, stage_no (1–12), name, phase, output_label, sla_hours, depends_on_stage_nos, gate_type (`auto`/`approval`), approver_role | |
| `task_template` | id, stage_definition_id, title, description, default_assignee_rule (`order_owner`/`finance`/`account_owner`/`role:X`), offset_hours (relative to stage start or to a milestone), anchor (`stage_start`/`ship_by`/`etd`/`eta`/`delivered`), priority, is_required, completion_type (`checkbox`/`document:<type>`/`approval`/`data:<field>`), quick_actions_json, condition_json | `condition_json` allows tasks only when relevant (e.g. transport_mode = sea) |
| `stage_instance` | id, order_id, stage_definition_id, status (`not_started`/`in_progress`/`blocked`/`complete`/`skipped`), started_at, due_at, completed_at, completed_by, approved_by | |
| `task` | id, order_id NULL, account_id NULL, stage_instance_id NULL, task_template_id NULL, exception_id NULL, title, owner_user_id, due_at, priority (`low`/`normal`/`high`/`urgent`), status (`open`/`in_progress`/`done`/`cancelled`/`snoozed`), snoozed_until, snooze_reason, completed_at, completed_by, source (`auto`/`manual`/`exception`/`ai`) | |

#### Exceptions

| Table | Key columns | Notes |
|-------|-------------|-------|
| `exception_type` | id, code, name, category, default_severity, default_owner_rule, resolve_sla_hours, escalation_policy_id, playbook_md, auto_detect_rule_id | Catalogue — see §6.2 |
| `exception` | id, exception_no, order_id, shipment_id NULL, exception_type_id, title, description, severity (`low`/`medium`/`high`/`critical`), impact_flags (`delivery`,`revenue`,`compliance`,`customer`), status (`open`/`acknowledged`/`in_progress`/`escalated`/`resolved`/`closed`/`cancelled`), owner_user_id, raised_by (user or `system`), raised_at, due_at, acknowledged_at, escalation_level (0–3), resolved_at, resolution_code, root_cause_code, resolution_notes, financial_impact, is_auto_closed | |
| `exception_event` | id, exception_id, event (`raised`/`ack`/`reassigned`/`escalated`/`severity_changed`/`comment`/`resolved`/`reopened`), from_value, to_value, actor, at | Full audit trail |
| `escalation_policy` / `escalation_step` | id, name / policy_id, level, after_hours, notify_role, reassign_to_role, channel (`teams`/`email`/`both`) | |
| `detection_rule` | id, code, description, entity, schedule (`event`/`cron`), expression_json, exception_type_id, is_active | Configurable rules engine |

#### Documents

| Table | Key columns | Notes |
|-------|-------------|-------|
| `document_type` | id, code (`CUST_PO`,`SUPP_PO`,`PACK_LIST`,`COMM_INV`,`CERT_ORIGIN`,`PHYTO`,`ANALYSIS_CERT`,`BL`,`AWB`,`CUSTOMS_DECL`,`POD`,`SUPP_INV`,`CUST_INV`,`LABEL_PROOF`,`OTHER`), name, retention_years | |
| `document` | id, order_id NULL, shipment_id NULL, account_id NULL, document_type_id, title, current_version_id, status (`draft`/`under_review`/`approved`/`rejected`/`superseded`), required_by_requirement_id NULL | |
| `document_version` | id, document_id, version_no, sharepoint_item_id, drive_id, file_name, mime_type, size_bytes, checksum, uploaded_by, uploaded_via (`portal`/`email`/`partner_link`/`generated`), uploaded_at, extracted_json | `extracted_json` holds OCR/AI-extracted fields |
| `order_document_requirement` | id, order_id, document_type_id, required_by_stage_no, status (`missing`/`received`/`approved`/`waived`), source_requirement_id | Drives "Missing documents" |

#### Supply, logistics & finance

| Table | Key columns | Notes |
|-------|-------------|-------|
| `supplier_po` | id, supplier_po_no, order_id, supplier_partner_id, issued_at, acknowledged_at, status (`draft`/`issued`/`acknowledged`/`in_production`/`ready`/`collected`/`closed`), ready_date_promised, ready_date_actual, total_cost, currency, bc_purchase_order_no | |
| `supplier_po_line` | id, supplier_po_id, product_id, quantity, unit_cost, confirmed_qty | |
| `shipment` | id, shipment_no, mode (`air`/`sea`/`road`/`courier`), forwarder_partner_id, warehouse_partner_id, broker_partner_id, booking_ref, awb_bl_no, container_no, origin, destination, collection_planned, collection_actual, etd, atd, eta_original, eta_current, ata, delivered_at, status (`planned`/`booked`/`collected`/`departed`/`in_transit`/`arrived`/`customs`/`out_for_delivery`/`delivered`/`exception`), temp_controlled, pallets, gross_kg, pod_received_at | |
| `order_shipment` | order_id, shipment_id, allocated_cases | M:N consolidation/split |
| `tracking_event` | id, shipment_id, code, description, location, occurred_at, source (`api`/`email`/`manual`), raw_json | |
| `customer_invoice` | id, invoice_no, order_id, destination_id, amount, currency, issued_at, due_at, status (`draft`/`validated`/`issued`/`paid`/`disputed`), bc_invoice_no, validation_result_json | |
| `supplier_invoice` | id, supplier_invoice_no, supplier_po_id, amount, currency, received_at, match_status (`unmatched`/`matched`/`variance`), variance_amount, status (`received`/`validated`/`submitted`/`approved`/`paid`/`on_hold`), bc_purchase_invoice_no | Three-way match: supplier PO ↔ receipt/collection ↔ invoice |

#### Collaboration & audit

| Table | Key columns | Notes |
|-------|-------------|-------|
| `activity` | id, order_id, entity_type, entity_id, activity_type (`status_change`/`email_in`/`email_out`/`document`/`comment`/`task`/`exception`/`shipment_event`/`system`), actor_user_id NULL, actor_label, summary, body_ref, occurred_at, is_customer_visible | Feeds the order timeline; append-only |
| `email_message` | id, order_id, graph_message_id, conversation_id, direction, from_addr, to_addrs, subject, snippet, received_at, has_attachments | Links to Outlook/Exchange via Graph; body stays in Exchange |
| `comment` | id, order_id, entity_type, entity_id, author_user_id, body_md, mentions_json | |
| `notification` | id, user_id, type, entity_type, entity_id, channel, sent_at, read_at | |
| `lesson_learned` | id, order_id, account_id, category, text, action_for_account_requirement_id NULL, author | Captured at Stage 12; can be promoted to a Requirement |
| `audit_log` | id, entity_type, entity_id, field, old_value, new_value, actor, at | Field-level change history |

### 4.3 Key indexes & views

- `order(status, owner_user_id, health)`, `order(account_id, status)`, `task(owner_user_id, status, due_at)`, `exception(status, severity, owner_user_id)`, `shipment(status, eta_current)`.
- Full-text index on `order.customer_po_no`, `order.order_no`, `shipment.awb_bl_no/container_no`, `document_version.file_name`, plus Azure AI Search over document content.
- Materialised reporting views (refreshed every 15 min): `vw_order_stage_durations`, `vw_open_order_value`, `vw_pending_billing`, `vw_supplier_scorecard`.

---

## 5. Workflow Engine Design

### 5.1 Order status model

The order has **one top-level status** (what people talk about) derived from the stage instances (what the engine tracks):

| Order status | Meaning | Set when |
|--------------|---------|----------|
| `Received` | PO captured, order record exists | Order created |
| `Under Review` | Stage 1 complete ("accepted for review"), Stage 2 running | Stage 1 gate |
| `Approved` | Stage 2 complete | Stage 2 approval |
| `Released to Supplier` | Stage 3 running | Supplier PO issued |
| `Supplier Committed` | Stage 3 complete | Supplier acknowledgement |
| `In Preparation` | Stages 4–6 running | Auto |
| `Ready to Ship` | Stage 7 approved | Pre-shipment approval |
| `In Transit` | Stage 8 | Collection confirmed |
| `Delivered` | Stage 9 complete | POD received |
| `Invoiced` | Stage 10 complete | Customer invoice issued |
| `Settled` | Stage 11 complete | Supplier invoice submitted for payment |
| `Closed` | Stage 12 complete | Closure checklist complete |
| *Overlay flags:* `On Hold`, `Cancelled`, `At Risk` (health) | Can apply at any stage | Manual (hold/cancel) or engine (health) |

**Health** (green/amber/red) is independent of status and computed continuously:

```
red   if any open Critical/High exception
      or any stage past SLA
      or projected delivery > requested delivery
amber if any Medium exception
      or any required task due < 24h
      or stage SLA < 25% remaining
green otherwise
```

### 5.2 Stage definitions, gates, SLAs and auto-generated tasks

SLAs are defaults (configurable per workflow template / account). "Anchor" means the task due date is calculated relative to that milestone; otherwise it's relative to stage start.

| # | Stage | Starts when | Auto-generated tasks (default owner) | Gate / output | Default SLA |
|---|-------|-------------|---------------------------------------|---------------|-------------|
| 1 | PO Intake | Order created (manual, email, upload) | Confirm PO data (owner) · Review pricing vs price list (auto check → task only if variance) · Review quantities & availability (auto check) · Review delivery request vs lead time (auto check) · File PO (auto) | Auto when required tasks done → "Order accepted for review" | 4 business hrs |
| 2 | Order Validation | Stage 1 complete | Validate commercial terms · Review account rules (list of surfaced requirements to tick) · Review compliance & destination requirements · Record risks (optional) | **Approval gate** (Specialist/Manager, or self-approval if account `approval_mode = low_risk`) → "Order approved" | 1 business day |
| 3 | Supplier Release | Stage 2 approved | Generate supplier PO (one click, from template) · Send supplier instructions + account operational requirements (one-click email with attachments) · Confirm supplier acceptance (auto-completes on supplier reply/confirmation link) | Supplier acknowledgement → "Supplier committed" | 2 business days |
| 4 | Supply Coordination | Stage 3 complete | Confirm inventory/allocation · Confirm ready date · Monitor production (recurring check-in if ready date > 7 days out) | Ready date confirmed & allocation = order qty → "Supply secured" | Until ready date |
| 5 | Logistics Planning | Stage 3 complete (parallel with 4) | Assign forwarder/mode · Confirm warehouse requirements · Schedule collection · Confirm booking & ETA | Booking ref + ETA recorded → "Shipment planned" | anchor: ship_by − 5d |
| 6 | Documentation | Stage 3 complete (parallel) | One task per **required document** (from account + destination rules), e.g. Commercial invoice, Packing list, Certificate of origin, Phyto, Analysis cert, Label proof · Review & validate docs | All required docs `approved` → "Shipment package complete" | anchor: ship_by − 2d |
| 7 | Pre-Shipment Review | Stages 4, 5, 6 complete | Readiness checklist (auto-populated: supply ✓, booking ✓, docs ✓, requirements verified ✓) · Confirm booking · Final requirements check | **Approval gate** → "Shipment approved" | anchor: ship_by − 1d |
| 8 | Shipment Execution | Stage 7 approved | Confirm collection · Monitor transit (auto from tracking) · Send shipping notice/ASN to customer (one-click) | Departure confirmed → "Shipment in transit" | Until ETA |
| 9 | Delivery Management | ATA or customs event | Support customs clearance (if broker involved) · Confirm delivery · Obtain POD | POD uploaded → "Delivery complete" | anchor: delivered + 3d for POD |
| 10 | Customer Invoicing | Stage 9 complete (or at shipment if account `invoice_on = shipment`) | Create invoice (pre-filled in Business Central) · Validate pricing & account invoice rules · Issue billing documents | Invoice issued → "Customer invoiced" | 2 business days |
| 11 | Supplier Settlement | Supplier invoice received (parallel with 10) | Match supplier invoice to supplier PO (auto) · Validate documentation · Submit for payment | Submitted/approved → "Supplier settled" | 5 business days |
| 12 | Order Closure | Stages 10 & 11 complete | Close outstanding tasks/exceptions (auto-check) · Archive documentation (auto: folder set read-only, retention label applied) · Lessons learned (optional, 1 field; mandatory if order had High/Critical exception) | Auto → "Order closed" | 5 business days |

**Why this keeps the admin burden low:** most "Review X" activities are **automatic checks** that only create a task when something looks wrong. A clean order generates ~25 tasks across its life, most of which complete with one click or complete themselves from events.

### 5.3 Triggers

| Trigger type | Examples |
|--------------|----------|
| **Record events** | Order created; stage completed; document uploaded/approved; task done; exception resolved; field changed (e.g. `requested_delivery_date`) |
| **Integration events** | Email received in a monitored mailbox and matched to an order; supplier confirmation link clicked; forwarder API tracking update; Business Central invoice posted; SharePoint file added to order folder |
| **Time events** (scheduler, every 15 min) | Task overdue; stage SLA breach; ETA passed with no arrival; supplier no response for N hours; POD missing N days after delivery; order idle > N days |
| **User actions** | Approve gate; put on hold; escalate; cancel |

### 5.4 Engine mechanics

```
                ┌─────────────┐
 events ──────► │ Event bus   │ (Azure Service Bus topics)
 (API, Graph,   └──────┬──────┘
  BC, tracking,        │
  scheduler)           ▼
                ┌─────────────────────┐    reads    ┌──────────────────────┐
                │ Workflow Orchestrator│◄──────────►│ Workflow templates   │
                │  • advance stages    │            │ stage/task templates │
                │  • generate tasks    │            └──────────────────────┘
                │  • evaluate gates    │
                │  • compute health    │    reads    ┌──────────────────────┐
                │  • run detection     │◄──────────►│ Detection rules       │
                │    rules             │            │ Escalation policies   │
                └──────┬───────────────┘            └──────────────────────┘
                       │ writes
          ┌────────────┼──────────────┬───────────────────┐
          ▼            ▼              ▼                   ▼
     stage_instance   task        exception          notifications
                                                     (Teams/Outlook via
                                                      Power Automate/Graph)
```

- **Deterministic core in code** (C#/.NET or TypeScript) for stage transitions, gate evaluation, task generation and health — testable, versioned, fast.
- **Templates in data**, so the Admin can adjust checklists, SLAs and conditions without a release.
- **Power Automate for edge integrations and notifications** (Outlook, Teams, approvals, SharePoint), not for core state — this avoids "spaghetti flows" becoming the system of record.
- **Idempotent handlers** (each event has a key) so replays never duplicate tasks.
- **Template versioning:** an order runs on the template version it started on.

### 5.5 Automation opportunities (built-in)

| Automation | Stage | Effort saved |
|-----------|-------|--------------|
| Create SharePoint order folder with standard sub-folders & file PO | 1 | 5 min/order |
| Price & quantity validation vs price list and allocation | 1–2 | 10 min/order |
| Surface account + destination requirements and create verification tasks | 1–2 | Prevents most repeat errors |
| Generate supplier PO PDF + instruction email with requirements attached | 3 | 15 min/order |
| Supplier confirmation via one-click link (no login) → auto-complete task | 3 | Chasing time |
| Required-document list generated per order; reminders to supplier/forwarder at T-5/T-3/T-1 | 6 | 20 min/order |
| Readiness checklist auto-ticked from system state | 7 | 10 min/order |
| Tracking updates from forwarder API/email parsing; ETA slip detection | 8 | Manual tracking checks |
| Customer shipping notice (ASN) email pre-filled | 8 | 5 min |
| POD chase reminder; POD auto-matched from email attachments | 9 | Chasing time |
| Invoice pre-filled in Business Central from order lines; account invoice rules validated | 10 | 15 min/order |
| Supplier invoice 3-way match; variance exception if > tolerance | 11 | 10 min/order |
| Archive & retention label on closure | 12 | Compliance |
| Daily digest (Teams/email): my day, overdue, new exceptions | All | Morning triage |

---

## 6. Exception Framework

Exceptions are **first-class records**, not comments or flags. The framework answers: *what's wrong, how bad, who owns it, by when, and is it getting fixed?*

### 6.1 Lifecycle

```
         ┌──────────┐  owner acks  ┌──────────────┐ work starts ┌─────────────┐
 raise ─►│  OPEN    │─────────────►│ ACKNOWLEDGED │────────────►│ IN PROGRESS │
         └────┬─────┘              └──────┬───────┘             └──────┬──────┘
              │ not acked in SLA          │ due date passed            │
              ▼                           ▼                            │
         ┌──────────────────────────────────────┐                      │
         │ ESCALATED (L1 → L2 → L3)             │◄─────────────────────┤
         └──────────────────┬───────────────────┘                      │
                            │ resolved                                 │ resolved
                            ▼                                          ▼
                     ┌──────────────┐  verify / auto-verify  ┌──────────────┐
                     │   RESOLVED   │───────────────────────►│    CLOSED    │
                     └──────┬───────┘                        └──────────────┘
                            │ condition recurs
                            └──────────► REOPENED (→ OPEN, severity +1)
```

**Rules**
- **Raise:** automatically (detection rule), from a failed check, or manually (any user, 3 fields: type, order, note — severity/owner/due are defaulted).
- **Own:** default owner rule per type (order owner, finance, account owner). An exception can never be unowned; if the owner is out of office (Outlook OOF via Graph), it routes to the backup.
- **Due:** `raised_at + type.resolve_sla`, but never later than the next affected milestone (e.g. ship-by date).
- **Resolve:** requires a resolution code and root cause (picklists + optional note). Auto-detected exceptions **auto-resolve** when the condition clears (e.g. document uploaded) — the owner just confirms root cause in one click, or the system closes it after 24h.
- **Close:** Low/Medium close on resolve; High/Critical require Manager verification (one click in Teams).
- **Impact on the order:** open High/Critical → order health red; a **blocking** exception type (e.g. compliance) prevents the gate of the relevant stage.

### 6.2 Exception catalogue (defaults)

| Code | Type | Detected by | Default severity | Default owner | Resolve SLA | Blocks |
|------|------|------------|------------------|---------------|-------------|--------|
| `PRICE_VAR` | Pricing discrepancy | PO line price ≠ price list (± tolerance) | Medium (High if > 5% or > €5k) | Order owner | 1 day | Stage 2 |
| `QTY_AVAIL` | Product shortage | Qty > availability/allocation, or supplier confirms less | High | Order owner | 2 days | Stage 4 |
| `LEAD_TIME` | Unrealistic delivery request | Requested date < standard lead time | Medium | Order owner | 1 day | Stage 2 |
| `SUPP_NORESP` | Supplier non-response | No acknowledgement 48h after supplier PO issued | Medium → High at 96h | Order owner | 1 day | – |
| `SUPP_DELAY` | Production / ready-date slip | Ready date moved later or passed | High | Order owner | 1 day | – |
| `DOC_MISSING` | Missing documentation | Required doc not received by stage 6 due date | High (Critical if < 24h to ship-by) | Order owner | 1 day | Stage 7 |
| `DOC_REJECT` | Document error | Reviewer rejects a document / AI mismatch with order | Medium | Order owner | 1 day | Stage 7 |
| `REQ_FAIL` | Account requirement not met | Requirement verification failed | High | Account owner | 1 day | Relevant stage |
| `COMPLIANCE` | Compliance / regulatory issue | Destination rule unmet, licence/certificate expired | Critical | Account owner | 4 hrs | Stage 7 & 8 |
| `SHIP_DELAY` | Delayed shipment | ETA slip > tolerance (air 12h, sea 48h) or ETD missed | Medium; High if delivery date at risk; Critical if missed for airline | Order owner | 1 day | – |
| `CUSTOMS_HOLD` | Customs hold | Tracking/broker status = hold | High | Order owner | 1 day | – |
| `DAMAGE` | Damage / temperature excursion / shortage on delivery | Customer report, logger data, POD remarks | High | Account owner | 2 days | Stage 10 |
| `POD_MISSING` | Missing POD | No POD 3 days after delivery | Medium | Order owner | 2 days | Stage 10 |
| `INV_MISMATCH` | Invoice mismatch | Customer invoice ≠ order value/rules, or supplier invoice variance > tolerance | Medium | Finance | 2 days | Stage 10/11 |
| `INV_DISPUTE` | Customer invoice dispute | Customer AP rejects/disputes | High | Finance + account owner | 3 days | Stage 12 |
| `ORDER_IDLE` | Stalled order | No activity for 5 business days on an open order | Low | Order owner | 2 days | – |
| `UNOWNED` | Unowned work | Task/exception with inactive owner | High | Manager | 4 hrs | – |
| `OTHER` | Manual | User-raised | User choice | User choice | 2 days | – |

Each type has a **playbook** (3–5 suggested actions, e.g. for `SUPP_NORESP`: "Resend PO with read receipt · Call export manager · Notify account owner · Check alternative supplier"). Actions are one-click (send templated email, create follow-up task, notify).

### 6.3 Severity definitions

| Severity | Definition | Colour | Notification |
|----------|-----------|--------|--------------|
| **Critical** | Customer delivery will be missed, compliance breach, or > €25k at risk. | 🟥 | Immediate Teams + email to owner, backup and Manager; appears at top of Executive dashboard |
| **High** | Delivery at risk if not resolved within SLA; blocks a stage gate. | 🔴 | Immediate Teams to owner; Manager daily digest |
| **Medium** | Needs action but no immediate delivery risk. | 🟡 | In-app + daily digest |
| **Low** | Housekeeping. | ⚪ | In-app only |

Severity auto-escalates as time-to-impact shrinks (e.g. `DOC_MISSING` goes High → Critical at ship-by − 24h).

### 6.4 Escalation policy (default)

| Level | When | Who is notified / gets ownership | Channel |
|-------|------|-----------------------------------|---------|
| L0 | Raised | Owner | In-app (+Teams for High/Critical) |
| L1 | Not acknowledged within 4 business hrs (Critical: 1 hr) | Owner + backup | Teams |
| L2 | Past due date, or Critical unresolved 4 hrs | Operations Manager (added as co-owner) | Teams + email |
| L3 | Past due by 2 days, or Critical unresolved 24 hrs | Director + account's Sales owner informed | Email + Executive dashboard |

Manual escalation is always available with a required one-line reason.

### 6.5 Learning loop

- Root-cause codes (e.g. `supplier_process`, `customer_change`, `forwarder`, `internal_error`, `requirement_unclear`, `data_quality`) feed **Supplier Performance** and **Account Health**.
- At Stage 12, a lesson learned on an exception can be **promoted to an Account Requirement** in one click — so the next order automatically carries the fix. This is the mechanism by which the system gets smarter without anyone writing a manual.

---

## 7. Dashboard Designs

### 7.1 Executive Dashboard

Audience: Director/VP, Operations Manager. Refresh: near-real-time (≤ 15 min). Filter bar: Region · Account type · Account · Owner · Date range.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ Executive Dashboard       Region [All ▾]  Type [All ▾]  Period [Last 30 days ▾] │
├─────────────────────────────────────────────────────────────────────────────────┤
│ ┌───────────┐┌───────────┐┌───────────┐┌───────────┐┌───────────┐              │
│ │OPEN ORDERS││LATE ORDERS││WITH EXCEP.││MISSING    ││IN TRANSIT │              │
│ │   412  🔵 ││   19  🔴  ││   57  🟡  ││DOCUMENTS  ││   88  🔵  │              │
│ │ ▲ 6% wk   ││ 4.6% ▲1.2 ││ 13.8%     ││   31  🔴  ││ 7 delayed │              │
│ └───────────┘└───────────┘└───────────┘└───────────┘└───────────┘              │
│ ┌───────────┐┌───────────┐┌───────────┐┌───────────────────────┐               │
│ │AWAITING   ││REVENUE    ││CRITICAL   ││ OTIF (30d)            │               │
│ │INVOICE    ││PENDING    ││RISKS      ││   93.8%  🟡 target 96%│               │
│ │   34 🟡   ││BILLING    ││   3  🟥   ││ ▁▂▃▅▆▅▆▇ trend        │               │
│ │ oldest 9d ││ €1.26M 🟡 ││           ││                       │               │
│ └───────────┘└───────────┘└───────────┘└───────────────────────┘               │
│                                                                                 │
│ ORDERS BY STAGE (funnel/bar; red segment = past SLA)                            │
│  1 Intake      ▓▓▓ 14                                                           │
│  2 Validation  ▓▓▓▓▓ 22 ░2                                                      │
│  3 Supplier    ▓▓▓▓▓▓ 31 ░4                                                     │
│  4-6 Prepare   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 118 ░9                                           │
│  7 Pre-ship    ▓▓▓ 17                                                           │
│  8 In transit  ▓▓▓▓▓▓▓▓▓ 88 ░7                                                  │
│  9 Delivery    ▓▓▓ 21 ░3                                                        │
│  10 Invoicing  ▓▓▓▓▓ 34 ░5                                                      │
│  11 Settlement ▓▓▓▓ 41                                                          │
│  12 Closure    ▓▓ 26                                                            │
│                                                                                 │
│ CRITICAL RISKS                                   │ EXCEPTIONS BY TYPE (open)    │
│ 🟥 SO-24075 SkyAir SIN — delivery miss, flight   │ Doc missing   ▓▓▓▓▓▓ 18      │
│    delayed 72h · Marco · L2                      │ Ship delay    ▓▓▓▓ 12        │
│ 🟥 SO-24033 Harbor — customs hold (COLA) · Priya │ Supp. no-resp ▓▓▓ 9          │
│ 🟥 SO-24120 Grand Hotels — shortage 300 btl · …  │ Price var.    ▓▓ 7           │
│                                                  │ Shortage      ▓▓ 6           │
│ TOP ACCOUNTS AT RISK (health, open value)        │ Other         ▓ 5            │
│ SkyAir 🟡 €1.9M · Harbor Dist 🔴 €640k · …        │                              │
│                                                                                 │
│ TEAM WORKLOAD  Olivia ▓▓▓▓▓▓▓ 142 (6 overdue) · Marco ▓▓▓▓▓ 98 (1) · …          │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**KPI card definitions & colour thresholds (defaults, configurable)**

| KPI | Definition | Green | Amber | Red |
|-----|-----------|-------|-------|-----|
| Open Orders | status not in (Closed, Cancelled) | — (neutral blue) | | |
| Late Orders | projected or actual delivery > requested, or any stage past SLA | < 3% | 3–6% | > 6% |
| Orders with Exceptions | open orders with ≥ 1 open exception | < 10% | 10–20% | > 20% |
| Missing Documents | orders in stage ≥ 6 with a required doc missing past due | 0 | 1–10 | > 10 |
| Shipments in Transit | status in transit/arrived/customs | neutral; sub-label "N delayed" red if > 0 | | |
| Orders Awaiting Invoice | Stage 9 complete, Stage 10 not complete | oldest ≤ 2d | 3–5d | > 5d |
| Revenue Pending Billing | Σ order value awaiting invoice | ≤ 2 days of avg revenue | 2–5 | > 5 |
| Critical Risks | open Critical exceptions | 0 | — | ≥ 1 |
| OTIF | delivered on time & in full / delivered (30d) | ≥ 96% | 92–96% | < 92% |

Every card and chart segment is **clickable to the filtered list**. A weekly PDF/Teams digest of this page is sent Monday 07:00 local.

### 7.2 User Dashboard (My Work)

See wireframe §3.1. Design specifics:

| Zone | Content | Purpose |
|------|---------|---------|
| Greeting line | "You have X due today, Y overdue, Z escalations" | 5-second situational awareness |
| 5 KPI tiles (clickable filters) | Overdue · Due today · My open exceptions · My orders at risk · Escalated to me | Triage |
| Needs my action | Merged prioritised list of tasks + exceptions with inline quick actions | Where 70% of work happens |
| Upcoming milestones | 14-day agenda: ETDs, ETAs, collections, customer due dates, invoice deadlines | Look-ahead |
| My orders by phase | 4 stacked bars (Commit/Prepare/Move/Close), clickable | Portfolio view |
| Following / mentions | Orders I follow; comments where I'm @mentioned | Collaboration |

**Manager variant** adds: team toggle, workload by person (open/overdue), unassigned queue, exceptions awaiting verification, approvals waiting (Stage 2/7 gates).

**Finance variant** replaces milestones with: Ready to invoice (by age), Supplier invoices to match, Invoice exceptions.

### 7.3 Reporting dashboards (Insights)

| Dashboard | Metrics | Visuals |
|-----------|---------|---------|
| **Operational Performance** | Orders received/closed per week; cycle time total and **per stage** (median & P90); late shipments %; OTIF; first-time-right orders (no exceptions); exceptions per 100 orders; customer service: response time to customer emails, order-status inquiries, complaints/claims; tasks overdue % by person | Trend lines, stage-duration bar chart (bottleneck finder), control chart for cycle time |
| **Financial Metrics** | Pending invoicing (value, count, ageing buckets 0–2/3–5/6–10/10+ days); open order value by stage; revenue by customer/account; revenue by month (invoiced vs forecast from open orders); margin by account; supplier invoices pending; disputed invoices | Ageing bar, monthly stacked columns, top-10 customers table |
| **Supplier Performance** | On-time acknowledgement %, on-time ready %, on-time shipment %; documentation accuracy (docs first-time-approved %); issue frequency (exceptions per 100 orders by supplier & type); average response time; invoice match rate | Scorecard table with trend arrows, supplier drill-down |

Implementation: embedded **Power BI** reports (row-level security aligned with portal scoping) for Insights; KPI cards on Executive and My Work are native components reading the API for speed.

---

## 8. Technology Architecture & Microsoft Integrations

### 8.1 Architecture overview

```
 ┌──────────────── Users (browser, mobile, Teams tab) ─────────────────┐
 └───────────────────────────────┬─────────────────────────────────────┘
                                 │ HTTPS (Entra ID SSO)
                    ┌────────────▼────────────┐
                    │ Azure Front Door + WAF  │
                    └────────────┬────────────┘
             ┌───────────────────┴──────────────────┐
   ┌─────────▼──────────┐                 ┌─────────▼──────────┐
   │  Web App (SPA/SSR) │                 │ Partner upload     │
   │  Next.js/React +   │                 │ (token links)      │
   │  Fluent UI v9      │                 └─────────┬──────────┘
   └─────────┬──────────┘                           │
             │ REST/GraphQL + SignalR (live updates)│
   ┌─────────▼──────────────────────────────────────▼──────────┐
   │           API layer — ASP.NET Core (or Node/NestJS)       │
   │  Orders · Tasks · Exceptions · Documents · Shipments ·    │
   │  Accounts · Search · Reporting · AuthZ (RBAC + RLS)       │
   └──────┬────────────┬──────────────┬──────────────┬─────────┘
          │            │              │              │
   ┌──────▼─────┐ ┌────▼──────┐ ┌─────▼──────┐ ┌─────▼─────────────┐
   │ Azure SQL  │ │ Service   │ │ Azure AI   │ │ Microsoft Graph   │
   │ (RLS,      │ │ Bus       │ │ Search     │ │ SharePoint/OneDrive│
   │ temporal)  │ │ (events)  │ │ (docs+data)│ │ Outlook/Teams      │
   └────────────┘ └────┬──────┘ └────────────┘ └───────────────────┘
                       │
        ┌──────────────▼──────────────┐     ┌───────────────────────┐
        │ Workflow Orchestrator       │     │ Power Automate         │
        │ (Azure Functions / Durable  │◄───►│ (notifications, email │
        │ Functions: stages, tasks,   │     │ intake, approvals,    │
        │ health, detection, SLAs)    │     │ Teams adaptive cards) │
        └──────────────┬──────────────┘     └───────────────────────┘
                       │
        ┌──────────────▼──────────────┐     ┌───────────────────────┐
        │ Integration adapters        │     │ Power BI (Insights)   │
        │ Business Central API,       │     │ via SQL read replica  │
        │ forwarder tracking APIs,    │     └───────────────────────┘
        │ Azure OpenAI / Doc Intell.  │
        └─────────────────────────────┘
```

### 8.2 Front-end architecture

| Choice | Rationale |
|--------|-----------|
| **React + TypeScript** (Next.js) | Mainstream, fast, large talent pool; SSR for fast first load |
| **Fluent UI v9** | Native Microsoft 365 look & feel; accessible; users feel "at home"; works in Teams tabs |
| **TanStack Query** | Caching, optimistic updates → UI feels instant |
| **SignalR** | Live updates (another user completes a task, tracking event arrives) without refresh |
| **Virtualised tables** (TanStack Table + virtual) | 200+ rows smooth |
| **PWA** + responsive layouts | Mobile review; installable; offline read of last-viewed orders |
| **Teams app manifest** | The same web app surfaced as a Teams personal tab (My Work) and channel tab (Account) |
| **Command palette** (`cmdk`) | Search everywhere, keyboard-first |

**Performance budget:** first contentful paint < 1.5s, list interactions < 200ms, order page < 1s (single aggregated API call `/orders/{id}/workspace`).

### 8.3 Back-end architecture

- **Modular monolith** (ASP.NET Core recommended for Microsoft alignment and Business Central/Graph SDKs). Modules: Orders, Workflow, Exceptions, Documents, Logistics, Finance, Accounts, Identity, Integration, Reporting. A modular monolith is the right size for a single ops team — simpler to run than microservices, and modules can be split later.
- **Event-driven core:** every state change emits a domain event to Service Bus; the orchestrator and integrations subscribe.
- **Workflow orchestrator:** Azure Durable Functions for timers (SLAs, reminders, escalations) + deterministic stage logic in the domain layer.
- **Hosting:** Azure App Service / Container Apps; Azure Key Vault for secrets; Application Insights for telemetry.
- **API style:** REST with aggregate "workspace" endpoints for screens; OData-style filtering for lists; webhooks for partners.

### 8.4 Database design

- **Azure SQL Database** (schema in §4) with **temporal tables** on `order`, `order_line`, `exception`, `account_requirement` for built-in history; **Row-Level Security** policies on region/account.
- **Read replica** for Power BI and heavy reporting.
- **Azure AI Search** index combining orders, shipments, contacts and document content for the command bar.
- Why not Dataverse? Dataverse is viable if the organisation is Power Platform–first (see §8.8 alternative), but Azure SQL gives better performance for 50–200-order lists with complex health computations, cheaper at scale, and fuller control of the UX.

### 8.5 Workflow engine

See §5. Summary: templates in SQL; deterministic engine in the domain layer; Durable Functions for time-based rules; Power Automate for M365-facing automations (approvals, notifications, email intake). Admin UI to edit checklists, SLAs, conditions, detection thresholds — with versioning and a "preview impact" before publishing.

### 8.6 Permissions model

- **Authentication:** Microsoft Entra ID SSO (MFA, conditional access). Partners via **Entra External ID** (B2B guest) or signed, expiring, single-order upload links.
- **Authorisation:** RBAC (roles in §2) mapped from Entra security groups + **attribute scoping** (region, account) enforced in API and by SQL RLS. Field-level: financial fields (cost, margin) hidden from Viewer/Partner.
- **Approvals:** gate approvals recorded with user, timestamp, and snapshot of the checklist state.
- **Audit:** all changes in `audit_log` + temporal tables; exports logged.

### 8.7 Document storage model

- **SharePoint Online** is the document store (one site per region or per major account; one **document library "Orders"** with folder per order: `/{Account}/{Year}/{OrderNo}/` and sub-folders `01 Customer PO`, `02 Supplier`, `03 Logistics`, `04 Compliance & Certificates`, `05 Customs`, `06 Delivery & POD`, `07 Invoicing`).
- **Metadata columns** (content types) on each file: OrderNo, Account, DocType, Status, Version — synchronised with `document`/`document_version` tables, so files are findable from both SharePoint and the portal.
- **Versioning** = SharePoint major versions; the portal shows the version list and previews via Graph (`/preview` endpoint / Office Online).
- **Retention:** Microsoft Purview retention labels applied at Stage 12 (e.g. 7–10 years for customs/financial docs); folder set to read-only.
- **Search:** SharePoint search + Azure AI Search index (OCR'd text via Azure AI Document Intelligence).
- **OneDrive:** users can drag from OneDrive into the portal; "Open folder" opens the SharePoint folder (syncable to OneDrive/Explorer for those who prefer it).

### 8.8 Microsoft ecosystem integration map

| Product | Integration | Direction | How |
|---------|------------|-----------|-----|
| **SharePoint** | Order folders, document storage, versioning, retention, preview | Portal ↔ SP | Graph API; folder provisioning on order create; webhook on file added → document record & task auto-complete |
| **OneDrive** | Upload from/Save to; personal drafts | User ↔ Portal | Graph file picker |
| **Outlook** | (1) Shared ops mailbox monitored: emails matched to orders by PO/SO/AWB number → timeline + attachments filed. (2) Send emails from the order page using templates; replies thread back. (3) Outlook add-in: "File to order" / "Create order from this email". (4) OOF status drives backup routing | Both | Graph mail subscriptions; Outlook add-in (Office.js) |
| **Teams** | Notifications & escalations as adaptive cards (with Approve / Acknowledge buttons); personal tab = My Work; channel per key account with tab = Account profile; "Open chat about this order" (creates/links a chat with stakeholders); daily digest | Both | Teams app (tabs + bot), Graph |
| **Power Automate** | Approvals (Stage 2/7 gates via Approvals app), email intake flows, notifications, ad-hoc citizen automations that call the portal API (custom connector) | Both | Custom connector on the GWOH API; flows owned by a service account |
| **Business Central / NAV** | Customers, vendors, items, prices ← BC (master data sync nightly + on demand). Sales order, purchase order, sales invoice and purchase invoice → BC (created by the portal, posted in BC). Posted invoice/payment status ← BC | Both | BC API v2.0 (OData) / for NAV on-prem: web services via on-prem gateway or Azure Service Bus relay |
| **Excel** | Export any list/view; import order lines from customer Excel; "Open in Excel" live connection (Power Query to OData feed) for analysts; bulk update templates for admins | Both | OData endpoint + Excel export service |
| **Power BI** | Insights dashboards embedded in portal and Teams | Read | Power BI Embedded, RLS |
| **Copilot / Azure OpenAI** | See §10 | Read + suggest | Azure OpenAI with data grounding in portal API |

**ERP boundary (important for simplicity):** Business Central remains the **system of record for money and inventory** (posted invoices, payments, stock ledger). GWOH is the **system of record for operational process** (stages, tasks, exceptions, requirements, documents, communications). GWOH never duplicates ERP functions like costing, GL, or inventory valuation — it pre-fills and triggers them.

**Alternative (low-code) stack:** For a faster, smaller start, the MVP can be built on **Power Apps (model-driven + custom pages) + Dataverse + Power Automate + SharePoint**. Trade-offs: faster build and native M365 integration, but weaker UX control, slower large lists, and per-user licensing. Recommendation: use the pro-code stack if the team is > 15 users or wants the exception-driven UX described here; otherwise Power Platform for a 3-month pilot is acceptable, with the same data model.

### 8.9 Non-functional requirements

| Area | Target |
|------|--------|
| Availability | 99.9% business hours across time zones |
| Performance | See §8.2 budgets; search results < 500ms |
| Scale | 50 users, 5k active orders, 50k orders/year, 1M documents |
| Security | Entra SSO + MFA; encryption at rest/in transit; OWASP ASVS L2; penetration test before go-live |
| Accessibility | WCAG 2.2 AA |
| Localisation | UI in English at launch; dates/timezones per user; currency per account; multi-language ready |
| Backup/DR | SQL point-in-time restore 35 days; geo-replica; SharePoint native retention |

---

## 9. Recommended MVP

**Goal:** the smallest product that replaces the Excel tracker + Outlook folders and delivers ~80% of the value within **~12–14 weeks**.

### 9.1 The 80/20 insight

Most operational pain comes from four things: **not knowing what to do next**, **missing account-specific requirements**, **chasing missing documents**, and **finding out about problems too late**. The MVP attacks exactly those.

### 9.2 MVP scope

| In MVP ✅ | Deferred ⏭ |
|-----------|-----------|
| **Orders:** manual create (with Excel line paste + PO upload), order page with summary, 12-stage tracker, next-up checklist, lines, stakeholders, activity timeline (comments, status, tasks, docs) | Email ingestion into timeline (Phase 2); AI PO extraction |
| **Workflow engine:** 12 stages, default template, auto task generation, gates (2 approval gates), SLAs, health calculation | Account-specific workflow variants; template admin UI (config by admin via seed/Excel initially) |
| **My Work** landing page with merged tasks + exceptions, inline complete/snooze/reassign | Calendar view; Manager workload heatmap |
| **Tasks** list (My / Team / Overdue) | Ad-hoc recurring tasks |
| **Exceptions:** manual raise + 6 auto-detected types (`DOC_MISSING`, `SUPP_NORESP`, `SHIP_DELAY` (from manual ETA changes), `POD_MISSING`, `PRICE_VAR`, `ORDER_IDLE`), owner/severity/due, L1–L2 escalation by Teams/email | Full catalogue, playbooks, root-cause analytics, L3 |
| **Account profiles** with **Requirements Library** and auto-surfacing on the order (simple conditions: destination, transport mode) | Complex conditions; lesson → requirement promotion |
| **Documents:** upload to SharePoint order folder, doc type, versioning, preview, required-document checklist per order, missing docs view | Full-text OCR search; partner upload links |
| **Shipments:** manual entry of collection/ETD/ETA/status, visual timeline | Forwarder API tracking, map |
| **Executive dashboard** with the 9 KPI cards + orders by stage + critical risks | Full Insights suite (Power BI) |
| **Global search** (orders, POs, AWB/container, accounts) | Document content search |
| **Integrations:** Entra SSO, SharePoint, Teams notifications, Excel export, nightly BC master data import (customers, items, prices) | BC write-back (SO/PO/invoice creation), Outlook add-in, Power Automate connector |
| **Roles:** Coordinator, Specialist, Manager, Finance, Viewer, Admin | Partner portal |
| **Finance:** Stage 10/11 as checklist tasks with invoice # and amount fields | Automated invoice validation & 3-way match |

### 9.3 MVP delivery plan

| Sprint (2 wks) | Deliverable |
|----------------|------------|
| 0 | Discovery: map 3 pilot accounts' requirements; import open orders from Excel tracker; confirm stage checklists |
| 1 | Foundations: SSO, data model, account & order CRUD, SharePoint folder provisioning |
| 2 | Workflow engine: stages, task generation, gates, health; order page v1 |
| 3 | My Work, Tasks, search; requirements auto-surfacing |
| 4 | Exceptions + detection rules + Teams notifications; documents & missing-docs |
| 5 | Shipments; Executive dashboard; Excel export; BC master data import |
| 6 | UAT with pilot team, data migration of open orders, training (half-day), go-live for pilot region |

### 9.4 MVP success metrics

| Metric | Target after 90 days |
|--------|----------------------|
| Coordinator onboarding time | ≤ 1 day to work independently |
| Orders tracked in GWOH (vs Excel) | 100% of pilot region |
| Late orders | −30% |
| Missing documents at pre-shipment | −50% |
| Time spent on status-chasing / status reporting | −40% (survey + meeting time) |
| Days from delivery to invoice | −30% |
| Weekly active use | ≥ 90% of ops team daily |

### 9.5 One-day onboarding plan (built into the product)

| Time | Activity |
|------|----------|
| 09:00 | 20-min video/tour: 7 objects, 4 phases, the left rail |
| 09:30 | Guided walkthrough (in-app coach marks) of My Work and an order page |
| 10:30 | Shadow: complete real tasks on 5 orders with a buddy |
| 13:00 | Create 2 orders from real POs; see requirements surface |
| 14:30 | Handle 3 exceptions end to end |
| 16:00 | Own a small queue; empty-state tips and "What's this?" hovers remain available |

---

## 10. Future Enhancements (AI)

Delivered with **Azure OpenAI** + **Azure AI Document Intelligence**, grounded strictly in portal data with user-level permission trimming. AI always **proposes; humans confirm** anything that changes commitments, money or compliance.

| Phase | Capability | How it works | Value |
|-------|-----------|-------------|-------|
| **2** | **PO extraction** | Drop a PDF/Excel/email PO → Document Intelligence (custom model per major customer format) extracts header + lines → mapped to account, destination, SKUs → user reviews highlighted fields (confidence colour) → create | Intake from 10 min to 1–2 min |
| **2** | **Email-to-order creation** | Monitored mailbox; classifier detects new POs vs. order correspondence; new POs create a *draft order* in "Received"; correspondence is linked to the right order by PO/SO/AWB and entity matching | Nothing gets lost in inboxes |
| **2** | **Missing / wrong document detection** | Each uploaded document is classified (type) and key fields extracted (consignee, HS code, quantities, lot numbers, vintage, PO#) → cross-checked against order + account requirements → mismatches raise `DOC_REJECT` with the exact field highlighted | Catches errors before customs does |
| **2** | **Automatic task generation from communications** | LLM reads inbound email ("can you move delivery to the 15th?", "phyto inspection Tuesday") → proposes tasks, date changes, or exception updates in the order's Next Up section for one-click accept | Turns email into action |
| **3** | **Copilot assistant for order status inquiries** | Chat in portal, Teams and Outlook: "Where is SkyAir PO 889213?", "What's blocking Harbor's orders this week?", "Draft an update to J. Tan with current ETA". Answers cite order data and link to records; drafts emails in the account's tone | Sales & customers self-serve; ops saves hours/week |
| **3** | **Shipment risk prediction** | Model trained on history (lane, forwarder, season, supplier ready-date reliability, docs completeness, customs history, weather/port congestion feeds) → risk score per order at Stages 4–8 → "At risk" before it's late, with the top drivers explained | Earlier intervention; fewer Critical exceptions |
| **3** | **Smart prioritisation** | My Work ranking learns from outcomes (which tasks, when late, caused delays) | Focus on what matters |
| **3** | **Requirements assistant** | Upload a customer's supplier manual/contract → AI proposes structured Requirements Library entries for specialist review | Faster account onboarding |
| **4** | **Supplier & forwarder self-service portal** | Partners confirm POs, upload docs, update ready dates; AI validates on upload | Removes chasing |
| **4** | **Invoice auto-validation & dispute prediction** | Pre-issue check of invoice vs account invoice rules and past disputes | Faster cash |
| **4** | **Weekly narrative report** | Auto-generated executive summary: what changed, top risks, account highlights | Replaces manual status decks |
| **4** | **Anomaly detection** | Unusual order quantities, price outliers, duplicate POs | Error & fraud prevention |

**Responsible AI guardrails:** confidence thresholds with human review; every AI action attributed as "AI-suggested" in the timeline; no customer-facing message sent without user approval; prompt/response logging for audit; data stays in the tenant's Azure region.

---

## 11. Appendix: Stage Checklists & Default Rules

### 11.1 Stage checklist catalogue (default template)

Legend: **R** = required, **O** = optional, **A** = auto-completes from an event, **C** = conditional.

**Stage 1 – PO Intake** (owner: order owner)
- R/A Order record created, folder created, PO filed as v1
- R Confirm customer, account, destination, PO #, requested delivery date
- R/A Pricing check vs price list (task only created if variance)
- R/A Quantity & availability check (task only if shortage)
- R/A Delivery request vs lead time (task only if too short)
- → Output: *Order accepted for review*

**Stage 2 – Order Validation** (owner: order owner; approver: Specialist)
- R Commercial terms confirmed (Incoterm, currency, payment terms)
- R Account requirements reviewed (tick list auto-populated)
- C Destination/compliance requirements reviewed (import licence, label approval, excise)
- O Risks noted
- R Approve → Output: *Order approved*

**Stage 3 – Supplier Release**
- R Supplier PO generated (A: from template) and sent with instructions + requirements pack
- R/A Supplier acceptance (via link or matched email)
- → Output: *Supplier committed*

**Stage 4 – Supply Coordination**
- R Inventory/allocation confirmed per line
- R Ready date confirmed
- C Production check-ins (if ready date > 7 days away; weekly)
- C Shortage resolution (only if `QTY_AVAIL` open)
- → Output: *Supply secured*

**Stage 5 – Logistics Planning**
- R Forwarder & mode assigned
- C Warehouse requirements confirmed (if via 3PL warehouse)
- C Temperature control arranged (account/season rule)
- R Collection scheduled
- R Booking & ETA confirmed
- → Output: *Shipment planned*

**Stage 6 – Documentation**
- R One task per required doc (from account + destination rules)
- R Documents reviewed & validated against requirements
- → Output: *Shipment package complete*

**Stage 7 – Pre-Shipment Review** (approver: Specialist)
- R/A Readiness: supply ✓ booking ✓ docs ✓ requirements ✓ no blocking exceptions ✓
- R Booking reconfirmed
- R Approve → Output: *Shipment approved*

**Stage 8 – Shipment Execution**
- R/A Collection confirmed
- R/A Departure confirmed
- O Customer shipping notice sent (R if account rule)
- A Transit monitored (tracking events; delays → exception)
- → Output: *Shipment in transit*

**Stage 9 – Delivery Management**
- C Customs clearance supported (if broker/importer involvement)
- R Delivery confirmed
- R POD obtained & filed
- → Output: *Delivery complete*

**Stage 10 – Customer Invoicing** (owner: Finance)
- R Invoice created (BC pre-fill)
- R Pricing & account invoice rules validated
- R Invoice + billing documents issued (per account rule: portal upload, email, EDI)
- → Output: *Customer invoiced*

**Stage 11 – Supplier Settlement** (owner: Finance)
- R Supplier invoice received & filed
- R Matched to supplier PO & collection
- R Submitted for payment
- → Output: *Supplier settled*

**Stage 12 – Order Closure**
- R/A All tasks and exceptions closed
- R/A Documentation archived (retention label)
- C Lessons learned (mandatory if High/Critical exception occurred)
- → Output: *Order closed*

### 11.2 Default document requirements by transport & destination (examples)

| Document | Always | Air | Sea | EU→non-EU | US | Asia (varies) |
|----------|:--:|:--:|:--:|:--:|:--:|:--:|
| Customer PO | ✅ | | | | | |
| Supplier PO | ✅ | | | | | |
| Commercial invoice | ✅ | | | | | |
| Packing list | ✅ | | | | | |
| AWB | | ✅ | | | | |
| Bill of lading | | | ✅ | | | |
| Export declaration (e.g. EAD/MRN) | | | | ✅ | | |
| Certificate of origin | | | | C (per FTA) | | C |
| Analysis certificate | | | | | | C |
| Health / phyto / free-sale certificate | | | | | | C |
| COLA / label approval, FDA prior notice | | | | | ✅ | |
| Import permit / licence | | | | | | C |
| POD | ✅ | | | | | |

Exact rules are maintained in `destination_requirement` by the Specialist role and reviewed quarterly.

### 11.3 Glossary (for the one-day learner)

| Term | Meaning |
|------|---------|
| **Order** | One customer PO being fulfilled end to end |
| **Account** | A customer's commercial program with its own rules (e.g. SkyAir – Business Class) |
| **Stage** | One of 12 steps; each has a checklist and an output |
| **Gate** | The output that lets an order move on (some need approval) |
| **Task** | A checklist item with owner and due date — mostly created for you |
| **Exception** | Anything that threatens the order; always has severity, owner, due date |
| **Requirement** | An account or destination rule the system reminds you about on every order |
| **Health** | Green / amber / red signal of whether the order is on track |
| **SLA** | Target time for a stage or exception |
| **POD** | Proof of delivery |
