/**
 * Version ranges, so a capability can say which builds of an app it was
 * recorded against.
 *
 * A capability targets a product and a build range; a tenant runs one concrete
 * build. Comparing the two before the first step is what stops an artifact
 * recorded against 2.1 from silently half-working against 3.0.
 *
 * The grammar is the familiar subset: `||` separates alternatives, whitespace
 * joins comparators that must all hold, and a comparator is one of
 * `>= > <= < =` or `^ ~`, or a bare version, or `*`.
 *
 * A prerelease suffix is parsed but not compared, so 2.1.0-rc.1 is treated as
 * 2.1.0. Capability targets name builds an institution actually runs.
 */

/** major, minor, patch. A prerelease or build suffix is not compared. */
type Triple = [number, number, number];

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

function parse(version: string): Triple | null {
  const match = VERSION.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isVersion(value: string): boolean {
  return parse(value) !== null;
}

export function compareVersions(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/** A comparator as a half-open bound, so every operator reduces to the same test. */
interface Bound {
  operator: ">=" | ">" | "<=" | "<" | "=";
  version: Triple;
}

function boundsOf(comparator: string): Bound[] | null {
  const text = comparator.trim();
  // `*` is a deliberate "any build"; nothing at all is an unfinished field, and
  // treating the two alike would turn an empty appVersion into no guard.
  if (text === "*") return [];
  if (text === "") return null;

  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(text);
  if (!match) return null;
  const operator = match[1] ?? "=";
  const version = parse(match[2] ?? "");
  if (!version) return null;

  const [major, minor] = version;
  switch (operator) {
    case "^":
      // A leading zero major has no compatible range above it, so ^0.2.3
      // admits patches only, exactly as ~0.2.3 does.
      return [
        { operator: ">=", version },
        {
          operator: "<",
          version: major === 0 ? [0, minor + 1, 0] : [major + 1, 0, 0],
        },
      ];
    case "~":
      return [
        { operator: ">=", version },
        { operator: "<", version: [major, minor + 1, 0] },
      ];
    default:
      return [{ operator: operator as Bound["operator"], version }];
  }
}

function alternativesOf(range: string): Bound[][] | null {
  const alternatives: Bound[][] = [];
  for (const alternative of range.split("||")) {
    const bounds: Bound[] = [];
    for (const comparator of alternative.trim().split(/\s+/)) {
      const parsed = boundsOf(comparator);
      if (!parsed) return null;
      bounds.push(...parsed);
    }
    alternatives.push(bounds);
  }
  return alternatives;
}

/** Whether a range is well formed, so an authoring mistake is caught on load. */
export function isValidRange(range: string): boolean {
  return alternativesOf(range) !== null;
}

function holdsFor(version: Triple, bound: Bound): boolean {
  const order = compareVersions(version, bound.version);
  switch (bound.operator) {
    case ">=":
      return order >= 0;
    case ">":
      return order > 0;
    case "<=":
      return order <= 0;
    case "<":
      return order < 0;
    case "=":
      return order === 0;
  }
}

/** False for a version or range that does not parse; callers report, not throw. */
export function satisfies(version: string, range: string): boolean {
  const parsed = parse(version);
  const alternatives = alternativesOf(range);
  if (!parsed || !alternatives) return false;
  return alternatives.some((bounds) => bounds.every((bound) => holdsFor(parsed, bound)));
}
