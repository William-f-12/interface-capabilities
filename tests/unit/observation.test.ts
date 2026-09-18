/**
 * How a screen is rendered into a budget.
 *
 * This is what a failure report's `observed` is made of, and what a discovery
 * agent is given to look at, so what survives truncation decides whether either
 * is any use.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderObservation, type Observation } from "@icap/core";

function frames(sizes: Record<string, number>): Observation {
  return {
    url: "http://localhost:4173/",
    title: "Northstar Core 2.1",
    frames: Object.entries(sizes).map(([name, lines]) => ({
      path: name === "<top>" ? [] : [name],
      url: `http://localhost:4173/${name}`,
      tree: `${name.toUpperCase()} line\n`.repeat(lines) + `END-OF-${name.toUpperCase()}`,
    })),
    hash: "abc",
  };
}

test("an observation inside its budget is rendered whole", () => {
  const rendered = renderObservation(frames({ nav: 2, content: 2 }), 4000);
  assert.match(rendered, /# Northstar Core 2\.1/);
  assert.match(rendered, /END-OF-NAV/);
  assert.match(rendered, /END-OF-CONTENT/);
  assert.doesNotMatch(rendered, /truncated/);
});

test("every frame is still named when the budget is too small for all of them", () => {
  const rendered = renderObservation(frames({ "<top>": 1, nav: 80, content: 80 }), 600);
  for (const name of ["<top>", "nav", "content"]) {
    assert.ok(rendered.includes(`## frame ${name}`), `${name} was dropped entirely`);
  }
  assert.match(rendered, /truncated/);
});

test("a frameset's last frame survives, because that is where the failure is", () => {
  // Navigation comes first and is long; without a per-frame share the content
  // frame is exactly what gets cut off.
  const rendered = renderObservation(frames({ nav: 200, content: 5 }), 500);
  assert.ok(rendered.includes("## frame content"), "the content frame was cut off");
  assert.match(rendered, /END-OF-CONTENT/, "and it was cut off before saying anything");
});

test("room a small frame does not need rolls on to the next", () => {
  const generous = renderObservation(frames({ "<top>": 1, content: 200 }), 900);
  const stingy = renderObservation(frames({ "<top>": 1, nav: 200, content: 200 }), 900);
  const contentOf = (text: string) => text.slice(text.indexOf("## frame content")).length;
  assert.ok(
    contentOf(generous) > contentOf(stingy),
    "a tiny top frame should leave more for content, not the same",
  );
});

test("the rendering stays within its budget, give or take the truncation markers", () => {
  const budget = 500;
  const rendered = renderObservation(frames({ "<top>": 1, nav: 300, content: 300 }), budget);
  assert.ok(
    rendered.length <= budget + 3 * "\n… truncated".length,
    `rendered ${rendered.length} chars against a ${budget} budget`,
  );
});

test("an observation with no frames is its header and nothing else", () => {
  const observation: Observation = {
    url: "about:blank",
    title: "",
    frames: [],
    hash: "0",
  };
  assert.equal(renderObservation(observation, 50), "# \nabout:blank\n");
});
