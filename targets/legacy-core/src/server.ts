/**
 * Northstar Core 2.1 — a fixture standing in for a legacy back-office UI.
 * See README.md in this package for what is deliberately awkward about it.
 */

import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { findById, search, users } from "./data.js";
import { arm, armed, consume, isChaosMode, type ChaosState } from "./chaos.js";
import * as pages from "./pages.js";

const PORT = Number(process.env.LEGACY_CORE_PORT ?? 4173);
const SESSION_TTL_MS = Number(process.env.LEGACY_CORE_SESSION_TTL_MS ?? 30 * 60 * 1000);

interface Session {
  user: string;
  role: string;
  name: string;
  lastSeen: number;
  chaos: ChaosState;
}

const sessions = new Map<string, Session>();

/** Chaos armed before anyone signs in, handed to the next session created. */
const pendingChaos: ChaosState = armed();

const app = express();
app.use(express.urlencoded({ extended: false }));

/* ─────────────────────────── session ─────────────────────────── */

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

function currentSession(req: Request): Session | undefined {
  const id = readCookie(req, "sid");
  if (!id) return undefined;
  const session = sessions.get(id);
  if (!session) return undefined;
  if (Date.now() - session.lastSeen > SESSION_TTL_MS) {
    sessions.delete(id);
    return undefined;
  }
  session.lastSeen = Date.now();
  return session;
}

function send(res: Response, html: string): void {
  res.type("html").send(html);
}

/* ─────────────────────────── chaos ─────────────────────────── */

app.get("/_chaos", (req, res) => {
  const mode = String(req.query.mode ?? "none");
  // A non-numeric times would otherwise arm a counter that never reaches zero.
  const times = Math.max(1, Math.trunc(Number(req.query.times ?? 1)) || 1);
  if (!isChaosMode(mode)) {
    res.status(400).type("text").send(`unknown mode: ${mode}`);
    return;
  }
  const session = currentSession(req);
  arm(session ? session.chaos : pendingChaos, mode, times);
  res.type("text").send(`armed ${mode} x${mode === "none" ? 0 : times}`);
});

/**
 * Renders an injected fault instead of the page, or null to carry on.
 * Interstitials apply to GET only, so a form post is never silently discarded.
 */
function faultFor(req: Request, session: Session): string | null {
  const interstitialOnly = session.chaos.mode === "notice" || session.chaos.mode === "slow_load";
  if (interstitialOnly && req.method !== "GET") return null;

  const mode = consume(session.chaos);
  const returnTo = req.originalUrl;
  switch (mode) {
    case "session_expired":
      return pages.signIn("Your session has timed out.");
    case "permission_denied":
      return pages.permissionDenied();
    case "app_error":
      return pages.appError();
    case "notice":
      return pages.systemNotice(returnTo);
    case "slow_load":
      return pages.slowLoad(returnTo);
    default:
      return null;
  }
}

/* ─────────────────────────── auth ─────────────────────────── */

app.get("/login", (req, res) => {
  send(res, pages.signIn(req.query.expired ? "Your session has timed out." : null));
});

app.post("/login", (req, res) => {
  const user = String(req.body["ctl00$txtUser"] ?? "").trim();
  const password = String(req.body["ctl00$txtPass"] ?? "");
  const account = users[user];
  if (!account || account.password !== password) {
    send(res, pages.signIn("Invalid user ID or password."));
    return;
  }
  const id = randomUUID();
  sessions.set(id, {
    user,
    role: account.role,
    name: account.name,
    lastSeen: Date.now(),
    chaos: { ...pendingChaos },
  });
  arm(pendingChaos, "none", 0);
  res.setHeader("Set-Cookie", `sid=${id}; Path=/; HttpOnly`);
  res.redirect("/");
});

app.get("/logout", (req, res) => {
  const id = readCookie(req, "sid");
  if (id) sessions.delete(id);
  res.setHeader("Set-Cookie", "sid=; Path=/; Max-Age=0");
  res.redirect("/login");
});

/* ─────────────────────────── frames ─────────────────────────── */

app.get("/", (req, res) => {
  if (!currentSession(req)) {
    res.redirect("/login");
    return;
  }
  send(res, pages.frameset());
});

app.get("/nav", (req, res) => {
  const session = currentSession(req);
  if (!session) {
    send(res, pages.signIn("Your session has timed out."));
    return;
  }
  send(res, pages.nav(session.name));
});

/* ─────────────────────────── content ─────────────────────────── */

app.use("/content", (req, res, next) => {
  const session = currentSession(req);
  if (!session) {
    send(res, pages.signIn("Your session has timed out."));
    return;
  }
  const fault = faultFor(req, session);
  if (fault) {
    send(res, fault);
    return;
  }
  next();
});

app.get("/content/Home.aspx", (_req, res) => send(res, pages.home()));
app.get("/content/Transactions.aspx", (_req, res) => send(res, pages.placeholder("Transactions")));
app.get("/content/Reports.aspx", (_req, res) => send(res, pages.placeholder("Reports")));

app.get("/content/MemberSearch.aspx", (_req, res) => {
  send(res, pages.memberSearch("", "", null));
});

app.post("/content/MemberSearch.aspx", (req, res) => {
  const memberId = String(req.body["ctl00$cph1$txtMemberId"] ?? "");
  const lastName = String(req.body["ctl00$cph1$txtLastName"] ?? "");
  send(res, pages.memberSearch(memberId, lastName, search(memberId, lastName)));
});

app.get("/content/MemberDetail.aspx", (req, res) => {
  const member = findById(String(req.query.id ?? ""));
  if (!member) {
    send(res, pages.memberSearch("", "", []));
    return;
  }
  send(res, pages.memberDetail(member, String(req.query.tab ?? "summary")));
});

/* ─────────────────────────── assets ─────────────────────────── */

const BLANK_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==",
  "base64",
);

app.get("/img/:name", (_req, res) => {
  res.type("gif").send(BLANK_GIF);
});

app.use((_req, res) => {
  res.status(404);
  send(res, pages.appError());
});

app.listen(PORT, () => {
  console.log(`legacy-core listening on http://localhost:${PORT}`);
});
