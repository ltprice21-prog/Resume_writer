# AMI Order Desk — Teams edition

`AMI-Order-Desk-Teams.html` is the multi-account version of the portal. Same engine, same
guarantees; adds divisions, per-user account lists, and templates that live with the account
instead of in one person's browser.

The single-account version (`AMI-Order-Desk.html`) is unchanged and still works on its own.

---

## How the sharing works

There is no server and no sign-in. Everything shared lives as ordinary files in **one folder**:

```
AMI Order Desk/                       <- a SharePoint library, synced through OneDrive
  AMI-Order-Desk-Teams.html           the app
  workspace.json                      divisions, accounts, people, contacts
  templates/
    aeromexico/
      vendor-order.html               a template, with a small JSON header
      trucker-booking.html
    delta/
      customer-update.html
  trackers/
    Aeromexico Tracking Chart.xlsx
    Delta Tracking Chart.xlsx
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

## Divisions, accounts and people

- **Divisions** — Europe and US by default; add or rename any.
- **Accounts** — one per customer or programme (Aeromexico, Delta, British Airways). Each has
  its own tracker file, sheet, standing contacts and templates.
- **People** — each has a division and, optionally, a list of accounts.

Visibility follows one rule: assign someone specific accounts and they see exactly those;
leave the list empty and they see every account in their division; mark them an administrator
and they see everything and can edit the shared setup.

> **This organises the view. It does not lock anything.**
> Anyone who can open the shared folder can open any tracker in it. If some accounts must be
> genuinely restricted, put them in separate SharePoint folders and set permissions there —
> that is the only place they can be enforced. The app is honest about this on screen.

Your choice of name is remembered in your browser; nothing else is stored locally.

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

Each template is tagged with who it goes to: **vendor / winery**, **trucker / forwarder**,
**customer / airline**, or **internal**. The Emails tab shows only templates for the
counterparty you picked.

### Placeholders

Anything in double braces is filled from the PO, the tracker and the account record:

| | |
| --- | --- |
| **Order** | `{{poCount}}` `{{poGroups}}` `{{poList}}` `{{table}}` |
| **Product** | `{{product}}` `{{size}}` `{{customer}}` `{{account}}` `{{division}}` |
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
next to the field. Otherwise it uses the account's standing contact for that counterparty.
Cc combines the PO's document address, the account's standing Cc, the contact's own Cc and
your personal Cc, deduplicated.

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
    teams.test.js         70 assertions   template ingestion, workspace model
    teams-ui.test.js      53 assertions   multi-account app in Chromium
```

```bash
node portal/build.js
node portal/tests/engine.test.js <fixturesDir>
node portal/tests/teams.test.js <fixturesDir>
node portal/tests/ui.test.js <fixturesDir>          # needs playwright
node portal/tests/teams-ui.test.js <fixturesDir>    # needs playwright
```

Fixtures (a sample PO PDF, a tracking chart, a saved `.msg`) are **not** committed — they hold
customer data. Point the tests at a local folder containing them.

### Without folder access

Firefox and Safari cannot open folders. There, use **Load a workspace bundle** — a `.zip` of
`workspace.json` and the templates, produced by **Export workspace bundle**. Changes stay in
that browser until you export a new bundle, so it is a stopgap, not a way to collaborate.
