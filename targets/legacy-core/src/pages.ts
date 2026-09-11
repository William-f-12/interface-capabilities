/**
 * HTML for the fixture. Table layout, generated control ids, a __VIEWSTATE
 * field that changes on every render, and full-page form posts.
 */

import type { Member } from "./data.js";

export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Changes on every render, so nothing about the page can be cached by shape. */
function viewState(): string {
  const bytes = Buffer.alloc(48);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return `/wEPDwUKL${bytes.toString("base64").replace(/[+/=]/g, "")}`;
}

function hiddenState(): string {
  return `<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="${viewState()}">
    <input type="hidden" name="__EVENTTARGET" id="__EVENTTARGET" value="">`;
}

const STYLE = `<style>
body{font-family:Verdana,Arial,sans-serif;font-size:11px;background:#dfe6ef;margin:0;padding:8px}
h2{font-size:14px;color:#123a6b;margin:0 0 8px 0;border-bottom:2px solid #123a6b;padding-bottom:3px}
table{border-collapse:collapse;font-size:11px}
caption{font-weight:bold;text-align:left;color:#123a6b;padding:4px 0}
th{background:#123a6b;color:#fff;padding:3px 8px;text-align:left;font-weight:normal}
td{padding:3px 8px;border-bottom:1px solid #b9c4d3}
a{color:#0b4ea2}
input[type=text],input[type=password]{border:1px inset #999;font-size:11px;padding:1px}
#noticeDialog{border:2px outset #ccc;background:#ffffe1;padding:10px;margin-bottom:10px;width:380px}
</style>`;

function shell(title: string, body: string): string {
  return `<html><head><title>${esc(title)}</title>${STYLE}</head><body>${body}</body></html>`;
}

/* ─────────────────────────── frames ─────────────────────────── */

export function frameset(): string {
  return `<html><head><title>Northstar Core 2.1</title></head>
<frameset cols="170,*" frameborder="1" border="1">
  <frame name="nav" src="/nav" scrolling="no">
  <frame name="content" src="/content/Home.aspx">
</frameset>
<noscript>This application requires frames.</noscript>
</html>`;
}

export function nav(userName: string): string {
  return shell(
    "Navigation",
    `<table cellpadding="4" cellspacing="0">
  <tr><td><b>${esc(userName)}</b></td></tr>
  <tr><td><a href="/content/Home.aspx" target="content">Home</a></td></tr>
  <tr><td><a href="/content/MemberSearch.aspx" target="content">Member Search</a></td></tr>
  <tr><td><a href="/content/Transactions.aspx" target="content">Transactions</a></td></tr>
  <tr><td><a href="/content/Reports.aspx" target="content">Reports</a></td></tr>
  <tr><td><a href="/logout" target="_top">Sign Out</a></td></tr>
</table>`,
  );
}

export function home(): string {
  return shell(
    "Home",
    `<h2>Home</h2><p>Select a function from the menu.</p>
     <p>Core build 2.1.0 &nbsp; Business date 09/10/2026</p>`,
  );
}

export function placeholder(name: string): string {
  return shell(name, `<h2>${esc(name)}</h2><p>This module is not part of the fixture.</p>`);
}

/* ─────────────────────────── sign in ─────────────────────────── */

export function signIn(message: string | null): string {
  return shell(
    "Sign In",
    `<h2>Please sign in</h2>
${message ? `<div role="alert">${esc(message)}</div>` : ""}
<form method="post" action="/login">
  ${hiddenState()}
  <table cellpadding="3">
    <tr><td><label for="ctl00_txtUser">User ID</label></td>
        <td><input type="text" id="ctl00_txtUser" name="ctl00$txtUser" size="18"></td></tr>
    <tr><td><label for="ctl00_txtPass">Password</label></td>
        <td><input type="password" id="ctl00_txtPass" name="ctl00$txtPass" size="18"></td></tr>
  </table>
  <input type="image" src="/img/btn_signin.gif" alt="Sign In" name="ctl00$btnSignIn">
</form>`,
  );
}

/* ─────────────────────────── member search ─────────────────────────── */

function searchForm(memberId: string, lastName: string): string {
  return `<form method="post" action="/content/MemberSearch.aspx">
  ${hiddenState()}
  <table cellpadding="3">
    <tr><td><label for="ctl00_cph1_txtMemberId">Member ID</label></td>
        <td><input type="text" id="ctl00_cph1_txtMemberId" name="ctl00$cph1$txtMemberId"
                   size="14" value="${esc(memberId)}"></td></tr>
    <tr><td><label for="ctl00_cph1_txtLastName">Last Name</label></td>
        <td><input type="text" id="ctl00_cph1_txtLastName" name="ctl00$cph1$txtLastName"
                   size="20" value="${esc(lastName)}"></td></tr>
  </table>
  <input type="image" src="/img/btn_search.gif" alt="Search" name="ctl00$cph1$btnSearch">
</form>`;
}

/**
 * Row ids carry the grid's control index, so the same member's View link has a
 * different id depending on where it lands in the result set.
 */
function resultsGrid(results: Member[]): string {
  const rows = results
    .map((m, i) => {
      const controlIndex = String(i + 2).padStart(2, "0");
      const linkId = `ctl00_cph1_grdMembers_ctl${controlIndex}_lnkView`;
      return `  <tr>
    <td>${esc(m.id)}</td>
    <td>${esc(m.lastName)}, ${esc(m.firstName)}</td>
    <td>${esc(m.branch)}</td>
    <td><a id="${linkId}" href="/content/MemberDetail.aspx?id=${esc(m.id)}">View</a></td>
  </tr>`;
    })
    .join("\n");

  return `<table cellpadding="0" cellspacing="0" width="520">
  <caption>Search Results</caption>
  <tr><th>Member ID</th><th>Name</th><th>Branch</th><th>&nbsp;</th></tr>
${rows}
</table>`;
}

export function memberSearch(
  memberId: string,
  lastName: string,
  results: Member[] | null,
): string {
  let body = `<h2>Member Search</h2>${searchForm(memberId, lastName)}`;
  if (results !== null) {
    body +=
      results.length === 0
        ? `<div role="alert">No members found for that search.</div>`
        : `<br>${resultsGrid(results)}`;
  }
  return shell("Member Search", body);
}

/* ─────────────────────────── member detail ─────────────────────────── */

function detailHeader(member: Member): string {
  const banner = member.restricted
    ? `<div role="status">This account is restricted. Contact Member Services before posting.</div>`
    : "";
  return `<h2>Member #${esc(member.id)}</h2>
${banner}
<table cellpadding="3">
  <tr><td>Member Name:</td><td>${esc(member.firstName)} ${esc(member.lastName)}</td></tr>
  <tr><td>Member Since:</td><td>${esc(member.memberSince)}</td></tr>
  <tr><td>Branch:</td><td>${esc(member.branch)}</td></tr>
</table>
<br>`;
}

function tabs(member: Member, active: string): string {
  const link = (tab: string, label: string) =>
    tab === active
      ? `<b>${label}</b>`
      : `<a href="/content/MemberDetail.aspx?id=${esc(member.id)}&tab=${tab}">${label}</a>`;
  return `<p>${link("summary", "Summary")} | ${link("accounts", "Accounts")} | ${link("notes", "Notes")}</p>`;
}

function accountsGrid(member: Member): string {
  const rows = member.accounts
    .map(
      (a) => `  <tr>
    <td>${esc(a.type)}</td><td>${esc(a.number)}</td>
    <td>${esc(a.balance)}</td><td>${esc(a.status)}</td>
  </tr>`,
    )
    .join("\n");
  return `<table cellpadding="0" cellspacing="0" width="460">
  <caption>Accounts</caption>
  <tr><th>Type</th><th>Account No</th><th>Balance</th><th>Status</th></tr>
${rows}
</table>`;
}

export function memberDetail(member: Member, tab: string): string {
  let panel: string;
  if (tab === "accounts") {
    panel = accountsGrid(member);
  } else if (tab === "notes") {
    panel = `<p>No notes on file.</p>`;
  } else {
    panel = `<p>Member in good standing. Select a tab for detail.</p>`;
  }
  return shell(
    `Member ${member.id}`,
    `${detailHeader(member)}${tabs(member, tab)}${panel}`,
  );
}

/* ─────────────────────────── injected faults ─────────────────────────── */

export function systemNotice(returnTo: string): string {
  return shell(
    "System Notice",
    `<div id="noticeDialog" role="dialog" aria-label="System Notice">
  <b>System Notice</b>
  <p>Scheduled maintenance begins tonight at 11:00 PM Central. Posting will be
     unavailable for approximately two hours.</p>
  <form method="get" action="${esc(returnTo)}">
    <input type="submit" value="Continue">
  </form>
</div>`,
  );
}

export function slowLoad(returnTo: string): string {
  return shell(
    "Processing",
    `<meta http-equiv="refresh" content="2;url=${esc(returnTo)}">
     <p>Please wait &mdash; processing your request.</p>`,
  );
}

export function permissionDenied(): string {
  return shell(
    "Not Authorized",
    `<h2>Member Services</h2>
     <div role="alert">You are not authorized to view this screen. Contact your supervisor.</div>`,
  );
}

export function appError(): string {
  return shell(
    "Error",
    `<h2>Unexpected Error</h2>
     <p>An unexpected error occurred while processing your request.</p>
     <p>Reference: CORE-500-${Math.floor(Math.random() * 900000 + 100000)}</p>`,
  );
}
