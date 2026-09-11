/** The load-time guards in CapabilitySchema, checked against bad artifacts. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CapabilitySchema } from "@icap/core";
import { repoRoot } from "../helpers/paths.js";

function loadCapability(id: string): any {
  return JSON.parse(readFileSync(join(repoRoot, "capabilities", id, "v1.json"), "utf8"));
}

const loadReference = () => loadCapability("member.lookup_savings_balance");

/** Every complaint the schema made, joined. */
function issuesOf(result: ReturnType<typeof CapabilitySchema.safeParse>): string {
  assert.equal(result.success, false, "expected this artifact to be rejected");
  return result.success ? "" : result.error.issues.map((i) => i.message).join(" | ");
}

/** Parse a mutated copy of the reference artifact and return the error text. */
function expectReject(mutate: (cap: any) => void): string {
  const capability = loadReference();
  mutate(capability);
  return issuesOf(CapabilitySchema.safeParse(capability));
}

test("the reference artifact is valid", () => {
  assert.equal(CapabilitySchema.safeParse(loadReference()).success, true);
});

test("an outcome cannot point at a step that does not exist", () => {
  const message = expectReject((cap) => {
    cap.outcomes[0].after = "search.sbumit";
  });
  assert.match(message, /references unknown step/);
});

test("every required output must be extracted by some step", () => {
  const message = expectReject((cap) => {
    cap.steps[4].extract = cap.steps[4].extract.filter((e: any) => e.to !== "savings_balance");
  });
  assert.match(message, /required output "savings_balance" is never extracted/);
});

test("a step cannot extract into an output that was never declared", () => {
  const message = expectReject((cap) => {
    cap.steps[4].extract[0].to = "member_nmae";
  });
  assert.match(message, /not a declared output/);
});

test("a template cannot reference an input that was never declared", () => {
  const message = expectReject((cap) => {
    cap.steps[1].action.value = "{{inputs.memberId}}";
  });
  assert.match(message, /undeclared input "memberId"/);
});

test("duplicate step ids are rejected", () => {
  const message = expectReject((cap) => {
    cap.steps[1].id = cap.steps[0].id;
  });
  assert.match(message, /duplicate step ids/);
});

test("an approved capability must have steps", () => {
  const message = expectReject((cap) => {
    cap.steps = [];
  });
  assert.match(message, /approved capability must have at least one step/);
});

test("a malformed regular expression is rejected on load", () => {
  const message = expectReject((cap) => {
    cap.outcomes[0].detect.allOf[1].text = { pattern: "no members? found (", flags: "i" };
  });
  assert.match(message, /invalid regular expression/);
});

test("the not-found detector still points at a pattern the test can reach", () => {
  const detect = loadReference().outcomes[0].detect;
  assert.ok(Array.isArray(detect.allOf), "detector shape changed; update the mutation above");
  assert.ok(detect.allOf[1]?.text?.pattern, "no pattern at the expected path");
});

test("a business outcome must say whether it halts or continues", () => {
  const message = expectReject((cap) => {
    delete cap.outcomes[0].onDetect;
  });
  assert.match(message, /must set onDetect/);
});

test("a contract-only draft is valid without steps or step bindings", () => {
  const draft = loadCapability("member.open_sub_account");
  const result = CapabilitySchema.safeParse(draft);
  assert.equal(result.success, true, JSON.stringify(result));
});

test("escalation must resume at a real step once steps exist", () => {
  const draft = loadCapability("member.open_sub_account");
  draft.approval = "approved";
  draft.steps = [
    {
      id: "nav.open_account",
      intent: "Open the new account screen.",
      action: { type: "click" },
      target: { primary: { kind: "ax", role: "link", framePath: ["nav"] } },
    },
  ];
  for (const outcome of draft.outcomes) outcome.after = "nav.open_account";

  assert.match(issuesOf(CapabilitySchema.safeParse(draft)), /unknown resumeFrom/);
});

test("a role outside the ARIA set is rejected on load", () => {
  // "text" reads like a role but is not one, so no surface can resolve it.
  const message = expectReject((cap) => {
    cap.steps[4].extract[0].target.role = "text";
  });
  assert.match(message, /invalid_enum_value|Invalid enum value/i);
});

test("a click with no target is rejected", () => {
  const message = expectReject((cap) => {
    delete cap.steps[0].target;
  });
  assert.match(message, /is a click with no target/);
});

test("a type action with no target is rejected", () => {
  const message = expectReject((cap) => {
    delete cap.steps[1].target;
  });
  assert.match(message, /is a type with no target/);
});

test("navigate and press need no target", () => {
  const capability = loadReference();
  capability.steps[0].action = { type: "navigate", path: "/content/MemberSearch.aspx" };
  delete capability.steps[0].target;
  assert.equal(CapabilitySchema.safeParse(capability).success, true);
});

test("both shipped capabilities declare a risk level and an approval state", () => {
  for (const id of ["member.lookup_savings_balance", "member.open_sub_account"]) {
    const capability = CapabilitySchema.parse(loadCapability(id));
    assert.ok(["read_only", "reversible", "irreversible"].includes(capability.risk));
    assert.ok(["draft", "approved"].includes(capability.approval));
  }
});

test("no capability or tenant file carries a literal credential", () => {
  for (const id of ["member.lookup_savings_balance", "member.open_sub_account"]) {
    const raw = readFileSync(join(repoRoot, "capabilities", id, "v1.json"), "utf8");
    assert.doesNotMatch(raw, /password|passwd|secret|api[_-]?key/i);
  }
});
