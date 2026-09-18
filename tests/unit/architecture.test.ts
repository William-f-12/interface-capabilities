/** Boundaries the repository claims, checked by walking the import graph. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { repoRoot } from "../helpers/paths.js";

const IMPORT = /\bfrom\s+["']([^"']+)["']/g;

function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(IMPORT)].map((match) => match[1] ?? "");
}

/** Every module reachable from an entry point by following relative imports. */
function reachable(entry: string): { files: string[]; packages: Set<string> } {
  const files: string[] = [];
  const packages = new Set<string>();
  const seen = new Set<string>();

  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    files.push(file);

    for (const specifier of importsOf(file)) {
      if (!specifier.startsWith(".")) {
        packages.add(specifier.replace(/^node:/, "node:"));
        continue;
      }
      visit(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
    }
  };

  visit(entry);
  return { files, packages };
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (entry.endsWith(".ts")) found.push(path);
  }
  return found;
}

test("the core package does not reach into the target fixture", () => {
  for (const file of sourceFiles(join(repoRoot, "packages", "core", "src"))) {
    for (const specifier of importsOf(file)) {
      assert.doesNotMatch(
        specifier,
        /targets|legacy-core/,
        `${relative(repoRoot, file)} imports ${specifier}`,
      );
    }
  }
});

test("importing @icap/core does not pull in a browser driver", () => {
  const { packages } = reachable(join(repoRoot, "packages", "core", "src", "index.ts"));
  assert.equal(
    packages.has("playwright"),
    false,
    `the barrel reaches: ${[...packages].join(", ")}`,
  );
});

test("the browser-backed surface is still reachable through the subpath", () => {
  const { packages } = reachable(join(repoRoot, "packages", "core", "src", "surface", "web.ts"));
  assert.equal(packages.has("playwright"), true);
});

// Both are validation libraries: zod types the artifact, ajv checks the JSON
// Schema an artifact publishes as its contract. Anything else reaching the
// barrel is a boundary being crossed, not a dependency being added.
const BARREL_DEPENDENCIES = ["zod", "ajv"];

test("the barrel depends on nothing outside its validation libraries and node", () => {
  const { packages } = reachable(join(repoRoot, "packages", "core", "src", "index.ts"));
  for (const name of packages) {
    const root = name.replace(/^([^/]+).*$/, "$1");
    assert.ok(
      BARREL_DEPENDENCIES.includes(root) || name.startsWith("node:"),
      `unexpected dependency in the barrel: ${name}`,
    );
  }
});
