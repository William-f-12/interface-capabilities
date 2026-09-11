/**
 * Turns text read off a screen into the type an extraction declares.
 *
 * A screen only ever yields strings. Everything a caller is promised —
 * a decimal amount, a calendar date, a closed set of statuses — is produced
 * here, and a value that cannot be produced is reported rather than guessed.
 */

import { MoneySchema, type Coercion } from "../artifact/schema.js";
import { escapeRegExp } from "../surface/template.js";

/**
 * `UNMAPPED_ENUM_VALUE` is kept apart from `COERCION_FAILED` so a result says
 * "the screen showed a status the map does not cover" rather than "unreadable".
 */
export type CoerceFailure = "COERCION_FAILED" | "UNMAPPED_ENUM_VALUE";

export type CoerceResult =
  | { ok: true; value: unknown }
  | { ok: false; cause: CoerceFailure; expected: string };

function fail(cause: CoerceFailure, expected: string): CoerceResult {
  return { ok: false, cause, expected };
}

/* ─────────────────────────── money ─────────────────────────── */

/** Group and decimal separators the locale itself reports. */
function separatorsOf(locale: string): { group: string; decimal: string } {
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
    return {
      group: parts.find((p) => p.type === "group")?.value ?? ",",
      decimal: parts.find((p) => p.type === "decimal")?.value ?? ".",
    };
  } catch {
    return { group: ",", decimal: "." };
  }
}

const MONEY_EXPECTED = 'a USD amount, e.g. "$1,234.56"';

function toMoney(raw: string, locale: string): CoerceResult {
  let text = raw.trim();
  let negative = false;

  // Ledgers show a negative as (1,234.56) rather than with a sign.
  const wrapped = /^\((.*)\)$/.exec(text);
  if (wrapped?.[1] !== undefined) {
    negative = true;
    text = wrapped[1].trim();
  }

  // Only USD is promised, so any other marker fails instead of being relabelled.
  text = text.replace(/USD/gi, "").replace(/\$/g, "").trim();
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1).trim();
  }

  const { group, decimal } = separatorsOf(locale);
  const digits = text
    .split(group)
    .join("")
    .replace(/\s/g, "")
    .replace(decimal, ".");

  if (!/^\d+(\.\d{1,4})?$/.test(digits)) return fail("COERCION_FAILED", MONEY_EXPECTED);

  const money = MoneySchema.safeParse({
    amount: negative && Number(digits) !== 0 ? `-${digits}` : digits,
    currency: "USD",
  });
  if (!money.success) return fail("COERCION_FAILED", MONEY_EXPECTED);
  return { ok: true, value: money.data };
}

/* ─────────────────────────── date ─────────────────────────── */

const DATE_TOKEN = /YYYY|MM|DD/g;

/** Builds a matcher from the format the artifact declares, e.g. `MM/DD/YYYY`. */
function toDate(raw: string, format: string): CoerceResult {
  const order: string[] = [];
  let pattern = "";
  let consumed = 0;

  for (const token of format.matchAll(DATE_TOKEN)) {
    pattern += escapeRegExp(format.slice(consumed, token.index));
    pattern += token[0] === "YYYY" ? "([0-9]{4})" : "([0-9]{2})";
    order.push(token[0]);
    consumed = token.index + token[0].length;
  }
  pattern += escapeRegExp(format.slice(consumed));

  if (!(order.includes("YYYY") && order.includes("MM") && order.includes("DD"))) {
    return fail("COERCION_FAILED", "a date format naming YYYY, MM and DD");
  }

  const match = new RegExp(`^${pattern}$`).exec(raw.trim());
  if (!match) return fail("COERCION_FAILED", `a date written as ${format}`);

  const field = (token: string): number => Number(match[order.indexOf(token) + 1]);
  const year = field("YYYY");
  const month = field("MM");
  const day = field("DD");

  // Round-tripping rejects a well-formed but impossible date such as 02/30.
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return fail("COERCION_FAILED", `a real calendar date written as ${format}`);
  }
  return { ok: true, value: date.toISOString().slice(0, 10) };
}

/* ─────────────────────────── the entry point ─────────────────────────── */

export function coerce(raw: string, spec: Coercion): CoerceResult {
  switch (spec.as) {
    case "string":
      return { ok: true, value: spec.trim ? raw.trim() : raw };

    case "Money":
      return toMoney(raw, spec.locale);

    case "integer": {
      const digits = raw.trim().replace(/[,\s]/g, "");
      if (!/^-?\d+$/.test(digits)) return fail("COERCION_FAILED", "a whole number");
      return { ok: true, value: Number(digits) };
    }

    case "date":
      return toDate(raw, spec.format);

    case "enum": {
      const mapped = spec.map[raw.trim()];
      if (mapped !== undefined) return { ok: true, value: mapped };
      // `onUnmapped` decides whether an unlisted value counts as a failure at
      // all; the extraction's `onCoerceFailure` then decides what happens to it.
      if (spec.onUnmapped === "null") return { ok: true, value: null };
      return fail(
        "UNMAPPED_ENUM_VALUE",
        `one of: ${Object.keys(spec.map).join(", ")}`,
      );
    }
  }
}
