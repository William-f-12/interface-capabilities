# legacy-core — test fixture

**This is not the deliverable.** It is a stand-in for the kind of back-office
application the system is built to drive: a fictional credit union core called
*Northstar Core 2.1*. Every member, account and balance in it is fabricated.

Run it from the repository root, and stop it with Ctrl+C:

```
npm run target                              # http://localhost:4173
```

Sign in as `teller` / `teller-pw`, or `supervisor` / `supervisor-pw`.

Set `LEGACY_CORE_PORT` to move it, or `LEGACY_CORE_SESSION_TTL_MS` to shorten
the idle timeout. If a previous run left the port held:

```
# macOS / Linux
lsof -ti tcp:4173 | xargs kill -9

# Windows PowerShell
Get-NetTCPConnection -LocalPort 4173 -State Listen |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force }
```

## What is deliberately awkward

| Trait | What it defeats |
| --- | --- |
| `<frameset>` with `nav` and `content` frames | Any locator that assumes one document |
| Generated control ids (`ctl00_cph1_grdMembers_ctl03_lnkView`) | Recorded DOM selectors — the index moves with the row |
| `__VIEWSTATE` that changes on every render | Caching a page by shape |
| Full-page form posts, not XHR | Waiting on network idle |
| Table layout, no CSS classes carrying meaning, no test ids | Structural selectors |
| `<input type="image">` for buttons | Anything looking for `<button>` |
| Balances as `$12,480.55`, dates as `MM/DD/YYYY` | Reading a value without typing it |
| Search returns joint holders as extra rows | Targeting a row by position |

## What accessibility it does have

Links, form fields, tables and headings carry native semantics, and a handful of
elements carry ARIA (`role="alert"` on validation messages, `role="status"` on
the restriction banner, `role="dialog"` on the notice interstitial). US
institutions operate under ADA and Section 508 pressure, and vendors bolt on
partial retrofits of exactly this kind — enough for the accessibility tree to be
the most reliable surface, nowhere near enough for the markup to be clean.

## Injecting runtime faults

```
curl "http://localhost:4173/_chaos?mode=notice&times=1"
```

| Mode | Effect on the next content render |
| --- | --- |
| `session_expired` | The sign-in form appears in the content frame |
| `notice` | A "System Notice" dialog with a Continue button (GET only) |
| `slow_load` | A "Please wait — processing" interstitial that refreshes after 2s (GET only) |
| `permission_denied` | "You are not authorized to view this screen" |
| `app_error` | "Unexpected Error" with a reference number |
| `none` | Clears whatever is armed |

`times` controls how many renders it applies to. Arming before sign-in carries
the fault into the session that is created next.

A member id nobody holds needs no fault injection — searching for one produces
"No members found", which is a business outcome rather than an error.

## Members

| Id | Name | Savings | Notes |
| --- | --- | --- | --- |
| 100001 | Margaret Chen | $12,480.55 | Joint with 100006 |
| 100002 | Robert Alvarez | $3,205.00 | Restricted |
| 100003 | Dana Whitfield | $87.20 | |
| 100004 | Samuel Okafor | $0.00 | Savings closed |
| 100005 | Priya Raman | $45,000.00 | |
| 100006 | Thomas Chen | $640.00 | Joint with 100001 |
