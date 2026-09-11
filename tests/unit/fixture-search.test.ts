/** The fixture's own search behaviour, which the integration test relies on. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { findById, search, users } from "../../targets/legacy-core/src/data.js";

test("a member id search also returns joint holders", () => {
  const results = search("100001", "").map((m) => m.id);
  assert.deepEqual(results, ["100001", "100006"]);
});

test("results are ordered by last name then first name", () => {
  const results = search("", "a").map((m) => `${m.lastName}, ${m.firstName}`);
  assert.deepEqual(results, ["Alvarez, Robert", "Okafor, Samuel", "Raman, Priya"]);
});

test("the same member lands at a different position depending on the search", () => {
  const byId = search("100005", "").findIndex((m) => m.id === "100005");
  const byName = search("", "a").findIndex((m) => m.id === "100005");
  assert.notEqual(byId, byName);
});

test("an unknown member id returns nothing", () => {
  assert.deepEqual(search("999999", ""), []);
});

test("an empty search returns nothing rather than everything", () => {
  assert.deepEqual(search("", ""), []);
  assert.deepEqual(search("  ", " "), []);
});

test("last name matching is case-insensitive and partial", () => {
  assert.deepEqual(
    search("", "CHEN").map((m) => m.id),
    ["100001", "100006"],
  );
});

test("findById is exact", () => {
  assert.equal(findById("100003")?.lastName, "Whitfield");
  assert.equal(findById("10000"), undefined);
});

test("every member has a savings account, which the capability reads", () => {
  for (const member of [...new Set(search("", "a").concat(search("100001", "")))]) {
    const savings = member.accounts.find((a) => a.type === "Savings");
    assert.ok(savings, `${member.id} has no savings account`);
    assert.match(savings.balance, /^\$[\d,]+\.\d{2}$/);
  }
});

test("the fixture defines both roles the capabilities ask for", () => {
  assert.equal(users.teller?.role, "teller");
  assert.equal(users.supervisor?.role, "supervisor");
});
