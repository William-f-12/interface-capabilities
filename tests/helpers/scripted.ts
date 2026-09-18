/**
 * A Surface whose screen is a set of facts, and a capability to drive across it.
 *
 * The engine's job is to decide what to do next, not to find things, so these
 * tests address every control by a unique `dom` selector and let the fallback
 * ladder and the real locator semantics be covered where they belong: the
 * ladder's own unit tests and the integration suite.
 */

import {
  CapabilitySchema,
  TenantConfigSchema,
  type Capability,
  type ElementLocator,
  type ElementRef,
  type Observation,
  type Surface,
  type TenantConfig,
} from "@icap/core";

export function keyOf(locator: ElementLocator): string {
  switch (locator.kind) {
    case "dom":
      return locator.selector;
    case "ax":
      return `ax:${locator.role}`;
    case "text":
      return "text";
    default:
      return `coords:${locator.x},${locator.y}`;
  }
}

/** One thing the surface was told to do, as a line a test can assert on. */
export type ActionEntry = string;

export interface ScriptedSurfaceOptions {
  /** Selectors present when the run starts. */
  facts?: string[];
  /** Text each selector yields when read. */
  text?: Record<string, string>;
  /** Runs after every action and may change what is on screen. */
  onAction?: (entry: ActionEntry, facts: Set<string>) => void;
  /** Selectors that appear on the nth look for that selector, standing in for a slow paint. */
  appearOnFind?: Record<string, number>;
  /** Thrown by the next call to observe(), to stand in for a dead surface. */
  breakOn?: "observe" | "click";
}

export class ScriptedSurface implements Surface {
  readonly actions: ActionEntry[] = [];
  readonly facts: Set<string>;
  readonly text: Record<string, string>;

  private readonly onAction: (entry: ActionEntry, facts: Set<string>) => void;
  private readonly breakOn: ScriptedSurfaceOptions["breakOn"];
  private readonly appearOnFind: Record<string, number>;
  private readonly looks = new Map<string, number>();

  constructor(options: ScriptedSurfaceOptions = {}) {
    this.facts = new Set(options.facts ?? []);
    this.text = options.text ?? {};
    this.onAction = options.onAction ?? (() => {});
    this.breakOn = options.breakOn;
    this.appearOnFind = options.appearOnFind ?? {};
  }

  private did(entry: ActionEntry): void {
    this.actions.push(entry);
    this.onAction(entry, this.facts);
  }

  async find(locator: ElementLocator): Promise<ElementRef | null> {
    const key = keyOf(locator);
    // Counted per selector: a look for one control says nothing about whether
    // another has painted yet.
    const look = (this.looks.get(key) ?? 0) + 1;
    this.looks.set(key, look);

    const due = this.appearOnFind[key];
    if (due !== undefined && look >= due) this.facts.add(key);

    return this.facts.has(key) ? key : null;
  }

  async observe(): Promise<Observation> {
    if (this.breakOn === "observe") throw new Error("the surface went away");
    return {
      url: "scripted://screen",
      title: "scripted",
      frames: [{ path: [], url: "scripted://screen", tree: [...this.facts].join("\n") }],
      hash: [...this.facts].sort().join(","),
    };
  }

  async click(ref: ElementRef): Promise<void> {
    if (this.breakOn === "click") throw new Error("the surface went away");
    this.did(`click ${ref}`);
  }

  async fill(ref: ElementRef, value: string, clearFirst: boolean): Promise<void> {
    this.did(`fill ${ref}=${value}${clearFirst ? "" : " (append)"}`);
  }

  async selectOption(ref: ElementRef, value: string): Promise<void> {
    this.did(`select ${ref}=${value}`);
  }

  async press(key: string): Promise<void> {
    this.did(`press ${key}`);
  }

  async navigate(path: string): Promise<void> {
    this.did(`navigate ${path}`);
  }

  async textOf(ref: ElementRef): Promise<string> {
    return this.text[ref] ?? "";
  }

  async describe(ref: ElementRef): Promise<string> {
    return ref;
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.alloc(0);
  }

  async close(): Promise<void> {}
}

/* ── the artifact under test ─────────────────────────────────────────────── */

const MONEY = {
  type: "object",
  additionalProperties: false,
  required: ["amount", "currency"],
  properties: {
    amount: { type: "string", pattern: "^-?[0-9]+([.][0-9]{1,4})?$" },
    currency: { const: "USD" },
  },
};

function baseCapability(): Record<string, unknown> {
  return {
    apiVersion: "capability/v1",
    id: "demo.lookup",
    version: "1.0.0",
    name: "Demo lookup",
    description: "A three-step flow used to exercise the engine.",
    target: { app: "demo-core", appVersion: ">=1.0.0 <2.0.0" },
    preconditions: { authenticated: false },
    risk: "read_only",
    approval: "approved",
    provenance: {
      source: "handwritten",
      createdAt: "2026-01-01T00:00:00Z",
      model: null,
      traceRef: null,
    },
    inputs: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: { query: { type: "string", pattern: "^[0-9]+$" } },
    },
    outputs: {
      type: "object",
      additionalProperties: false,
      required: ["amount", "status"],
      properties: { amount: MONEY, status: { enum: ["active", "closed"] } },
    },
    outcomes: [],
    steps: [
      {
        id: "open",
        intent: "Open the search screen.",
        action: { type: "click" },
        target: { primary: { kind: "dom", selector: "#open" } },
        checkpoint: { kind: "dom", selector: "#form" },
      },
      {
        id: "fill",
        intent: "Type the query.",
        action: { type: "type", value: "{{inputs.query}}" },
        target: { primary: { kind: "dom", selector: "#query" } },
      },
      {
        id: "submit",
        intent: "Submit the search and read the result.",
        action: { type: "click" },
        target: { primary: { kind: "dom", selector: "#submit" } },
        checkpoint: {
          anyOf: [
            { kind: "dom", selector: "#results" },
            { kind: "dom", selector: "#empty" },
          ],
        },
        extract: [
          {
            to: "amount",
            target: { kind: "dom", selector: "#amount" },
            coerce: { as: "Money" },
          },
          {
            to: "status",
            target: { kind: "dom", selector: "#status" },
            coerce: { as: "enum", map: { Active: "active", Closed: "closed" } },
          },
        ],
      },
    ],
    successCondition: { allRequiredOutputsPresent: true },
  };
}

function baseTenant(): Record<string, unknown> {
  return {
    apiVersion: "tenant/v1",
    tenantId: "demo",
    displayName: "Demo Institution",
    app: "demo-core",
    appVersion: "1.2.0",
    baseUrl: "http://localhost:9999",
    auth: {
      loginPath: "/login",
      credentials: {
        teller: { username: "env:DEMO_USER", password: "env:DEMO_PASSWORD" },
      },
      form: {
        username: { primary: { kind: "dom", selector: "#user" } },
        password: { primary: { kind: "dom", selector: "#password" } },
        submit: { primary: { kind: "dom", selector: "#signin" } },
      },
      signedIn: { kind: "dom", selector: "#signed-in" },
    },
    ambientOutcomes: [],
    targetOverrides: {},
    stepInsertions: [],
  };
}

/** Top-level keys replace wholesale, which is all these tests need. */
export function testCapability(patch: Record<string, unknown> = {}): Capability {
  return CapabilitySchema.parse({ ...baseCapability(), ...patch });
}

export function testTenant(patch: Record<string, unknown> = {}): TenantConfig {
  return TenantConfigSchema.parse({ ...baseTenant(), ...patch });
}

/** The screen the happy path walks, and the transitions that move it along. */
export function happyPathSurface(
  options: { amount?: string; status?: string } = {},
): ScriptedSurface {
  return new ScriptedSurface({
    facts: ["#open"],
    text: { "#amount": options.amount ?? "$1,204.50", "#status": options.status ?? "Active" },
    onAction: (entry, facts) => {
      if (entry === "click #open") facts.add("#form").add("#query").add("#submit");
      if (entry === "click #submit") facts.add("#results").add("#amount").add("#status");
    },
  });
}

/** Budgets small enough that a test never waits on a real timer for long. */
export const fastBudget = { wallClockMs: 4000, perStepMs: 120, maxRecoveries: 3 };
