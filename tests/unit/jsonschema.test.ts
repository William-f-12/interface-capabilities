/**
 * The published contract, checked as real JSON Schema.
 *
 * These schemas are meant to reach a calling agent as a tool definition
 * unchanged, so the keywords an author reaches for have to actually be enforced
 * rather than quietly ignored.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAgainstSchema } from "@icap/core";

const money = {
  type: "object",
  additionalProperties: false,
  required: ["amount", "currency"],
  properties: {
    amount: { type: "string", pattern: "^-?[0-9]+([.][0-9]{1,4})?$" },
    currency: { const: "USD" },
  },
};

const outputs = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["savings_balance", "account_status"],
  properties: {
    savings_balance: { $ref: "#/$defs/Money" },
    account_status: { enum: ["active", "restricted", "closed"] },
  },
  $defs: { Money: money },
};

const good = {
  savings_balance: { amount: "45000.00", currency: "USD" },
  account_status: "active",
};

test("a value the contract describes is accepted", () => {
  assert.deepEqual(checkAgainstSchema(outputs, good), { ok: true, errors: [] });
});

test("a $ref into $defs is followed, not skipped", () => {
  const check = checkAgainstSchema(outputs, {
    ...good,
    savings_balance: { amount: "45,000.00", currency: "USD" },
  });
  assert.equal(check.ok, false);
  assert.match(check.errors.join(" "), /savings_balance\.amount/);
});

test("a missing property is reported by name", () => {
  const { account_status: _dropped, ...partial } = good;
  const check = checkAgainstSchema(outputs, partial);
  assert.equal(check.ok, false);
  assert.match(check.errors.join(" "), /account_status/);
});

test("an unexpected property is named, since that is the one thing the reader needs", () => {
  const check = checkAgainstSchema(outputs, { ...good, branch: "Downtown" });
  assert.equal(check.ok, false);
  assert.match(check.errors.join(" "), /branch/);
});

test("an enum outside its set is refused", () => {
  const check = checkAgainstSchema(outputs, { ...good, account_status: "Active" });
  assert.equal(check.ok, false);
  assert.match(check.errors.join(" "), /account_status/);
});

test("a const is enforced, so a relabelled currency does not pass", () => {
  const check = checkAgainstSchema(outputs, {
    ...good,
    savings_balance: { amount: "1.00", currency: "EUR" },
  });
  assert.equal(check.ok, false);
  assert.match(check.errors.join(" "), /savings_balance\.currency/);
});

test("every violation is reported, not just the first", () => {
  const check = checkAgainstSchema(outputs, { account_status: "nope", extra: 1 });
  assert.equal(check.ok, false);
  assert.ok(check.errors.length >= 2, check.errors.join(" | "));
});

test("a path reads with dots, so a nested field is legible", () => {
  const check = checkAgainstSchema(outputs, {
    ...good,
    savings_balance: { amount: 45000, currency: "USD" },
  });
  assert.equal(check.ok, false);
  assert.equal(check.errors[0], "savings_balance.amount must be string");
});

test("a root-level problem says so rather than naming an empty path", () => {
  const check = checkAgainstSchema(outputs, "not an object");
  assert.equal(check.ok, false);
  assert.match(check.errors[0] ?? "", /^<root> /);
});

test("a schema that cannot be compiled is a reported failure, not a thrown one", () => {
  const check = checkAgainstSchema({ type: "object", properties: { x: { $ref: "#/$defs/Gone" } } }, {});
  assert.equal(check.ok, false);
  assert.match(check.errors.join(" "), /cannot be compiled/);
});

test("the same schema object is usable repeatedly, which is what a replay loop does", () => {
  for (let i = 0; i < 5; i += 1) {
    assert.equal(checkAgainstSchema(outputs, good).ok, true);
  }
});
