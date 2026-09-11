/** An in-memory Surface, so assertion and ladder logic can be tested without a browser. */

import type {
  AriaRole,
  BindingContext,
  ElementLocator,
  ElementRef,
  FindOptions,
  Observation,
  Surface,
} from "@icap/core";

/** Identity of a locator for the purposes of a test. */
export function keyOf(locator: ElementLocator): string {
  switch (locator.kind) {
    case "dom":
      return `dom:${locator.selector}`;
    case "ax":
      return `ax:${locator.role}`;
    case "text":
      return "text";
    default:
      return "coords";
  }
}

export interface FakeSurfaceOptions {
  /** Locator keys that resolve from the start. */
  present?: string[];
  /** Locator keys that start missing and appear on the nth find() call. */
  appearOnCall?: Record<string, number>;
}

export class FakeSurface implements Surface {
  /** Every locator key passed to find(), in order. */
  readonly lookups: string[] = [];
  readonly clicked: ElementRef[] = [];

  private readonly present: Set<string>;
  private readonly appearOnCall: Record<string, number>;
  private calls = 0;

  constructor(options: FakeSurfaceOptions = {}) {
    this.present = new Set(options.present ?? []);
    this.appearOnCall = options.appearOnCall ?? {};
  }

  async find(
    locator: ElementLocator,
    _ctx: BindingContext,
    _options?: FindOptions,
  ): Promise<ElementRef | null> {
    const key = keyOf(locator);
    this.lookups.push(key);
    this.calls += 1;

    if (this.present.has(key)) return `ref:${key}`;

    const threshold = this.appearOnCall[key];
    if (threshold !== undefined && this.calls >= threshold) {
      this.present.add(key);
      return `ref:${key}`;
    }
    return null;
  }

  async observe(): Promise<Observation> {
    return { url: "fake://", title: "fake", frames: [], hash: "0" };
  }

  async click(ref: ElementRef): Promise<void> {
    this.clicked.push(ref);
  }

  async fill(): Promise<void> {}
  async selectOption(): Promise<void> {}
  async press(): Promise<void> {}
  async navigate(): Promise<void> {}
  async textOf(): Promise<string> {
    return "";
  }
  async describe(ref: ElementRef): Promise<string> {
    return ref;
  }
  async screenshot(): Promise<Buffer> {
    return Buffer.alloc(0);
  }
  async close(): Promise<void> {}
}

export function dom(selector: string): ElementLocator {
  return { kind: "dom", selector, framePath: [] };
}

export function ax(role: AriaRole): ElementLocator {
  return { kind: "ax", role, framePath: [] };
}

export const noInputs: BindingContext = { inputs: {} };
