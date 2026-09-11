/** Screen text becomes a typed value, or says why it cannot. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { coerce, type CoerceResult } from "@icap/core";

function value(result: CoerceResult): unknown {
  assert.ok(result.ok, `expected a value, got ${result.ok ? "" : result.cause}`);
  return result.value;
}

/* ── money ───────────────────────────────────────────────────────────────── */

test("an amount as the fixture renders it becomes a decimal string", () => {
  const result = coerce("$45,000.00", { as: "Money", locale: "en-US" });
  assert.deepEqual(value(result), { amount: "45000.00", currency: "USD" });
});

test("a zero balance keeps its cents rather than collapsing to 0", () => {
  assert.deepEqual(value(coerce("$0.00", { as: "Money", locale: "en-US" })), {
    amount: "0.00",
    currency: "USD",
  });
});

test("an amount is never a float", () => {
  const amount = (value(coerce("$0.10", { as: "Money", locale: "en-US" })) as { amount: string })
    .amount;
  assert.equal(typeof amount, "string");
  assert.equal(amount, "0.10");
});

test("a ledger's parenthesised negative is read as negative", () => {
  assert.deepEqual(value(coerce("($1,234.56)", { as: "Money", locale: "en-US" })), {
    amount: "-1234.56",
    currency: "USD",
  });
});

test("a signed negative is read the same way, symbol on either side of the sign", () => {
  for (const text of ["-$45.00", "$-45.00"]) {
    assert.deepEqual(value(coerce(text, { as: "Money", locale: "en-US" })), {
      amount: "-45.00",
      currency: "USD",
    });
  }
});

test("negative zero is not produced", () => {
  assert.deepEqual(value(coerce("($0.00)", { as: "Money", locale: "en-US" })), {
    amount: "0.00",
    currency: "USD",
  });
});

test("separators come from the locale, not from a hardcoded guess", () => {
  assert.deepEqual(value(coerce("1.234,56 USD", { as: "Money", locale: "de-DE" })), {
    amount: "1234.56",
    currency: "USD",
  });
});

test("an amount in another currency fails rather than being relabelled USD", () => {
  const result = coerce("€1.234,56", { as: "Money", locale: "de-DE" });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.cause, "COERCION_FAILED");
});

test("a screen showing no value at all is a failure, not an empty amount", () => {
  for (const text of ["", "  ", "N/A", "--"]) {
    assert.equal(coerce(text, { as: "Money", locale: "en-US" }).ok, false, `accepted "${text}"`);
  }
});

test("more precision than Money promises is refused", () => {
  assert.equal(coerce("$1.234567", { as: "Money", locale: "en-US" }).ok, false);
});

/* ── enum ────────────────────────────────────────────────────────────────── */

const status = {
  as: "enum",
  map: { Active: "active", Restricted: "restricted", Closed: "closed" },
  onUnmapped: "hard_failure",
} as const;

test("a display status becomes the value the contract promises", () => {
  assert.equal(value(coerce("Active", status)), "active");
  assert.equal(value(coerce("  Restricted  ", status)), "restricted");
});

test("a status the map does not cover is reported as unmapped, not unreadable", () => {
  const result = coerce("Dormant", status);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.cause, "UNMAPPED_ENUM_VALUE");
  assert.match(result.ok === false ? result.expected : "", /Active, Restricted, Closed/);
});

test("an unmapped value is null when the artifact says to tolerate it", () => {
  assert.equal(value(coerce("Dormant", { ...status, onUnmapped: "null" })), null);
});

test("the map is matched exactly, so a near miss does not pass", () => {
  assert.equal(coerce("active", status).ok, false);
});

/* ── date ────────────────────────────────────────────────────────────────── */

test("a US-format date becomes an ISO date", () => {
  assert.equal(value(coerce("03/14/2009", { as: "date", format: "MM/DD/YYYY" })), "2009-03-14");
});

test("the format drives the reading, so the same digits read differently", () => {
  assert.equal(value(coerce("03/14/2009", { as: "date", format: "MM/DD/YYYY" })), "2009-03-14");
  assert.equal(value(coerce("14/03/2009", { as: "date", format: "DD/MM/YYYY" })), "2009-03-14");
});

test("a well-formed but impossible date is refused", () => {
  assert.equal(coerce("02/30/2009", { as: "date", format: "MM/DD/YYYY" }).ok, false);
});

test("a date that does not match the declared format is refused", () => {
  assert.equal(coerce("2009-03-14", { as: "date", format: "MM/DD/YYYY" }).ok, false);
});

test("a format that does not name all three fields is an authoring error", () => {
  assert.equal(coerce("03/2009", { as: "date", format: "MM/YYYY" }).ok, false);
});

test("format separators are matched literally, not as pattern characters", () => {
  assert.equal(coerce("03a14b2009", { as: "date", format: "MM.DD.YYYY" }).ok, false);
});

/* ── integer and string ──────────────────────────────────────────────────── */

test("a grouped count becomes a number", () => {
  assert.equal(value(coerce(" 1,204 ", { as: "integer" })), 1204);
});

test("a count with a fractional part is refused", () => {
  assert.equal(coerce("12.5", { as: "integer" }).ok, false);
});

test("a string is trimmed unless the artifact asks otherwise", () => {
  assert.equal(value(coerce("  Priya Raman  ", { as: "string", trim: true })), "Priya Raman");
  assert.equal(value(coerce("  padded  ", { as: "string", trim: false })), "  padded  ");
});
