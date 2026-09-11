/** A Surface backed by a real browser, perceiving through the accessibility tree. */

import { createHash } from "node:crypto";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
} from "playwright";
import type { ElementLocator, Scope } from "../artifact/schema.js";
import type {
  ElementRef,
  FindOptions,
  FrameObservation,
  Observation,
  Surface,
} from "./types.js";
import { render, toMatchOption, type BindingContext } from "./template.js";

type PlaywrightRole = Parameters<Locator["getByRole"]>[0];
type LocatorRoot = Locator | Frame;

/** Handles kept per surface, oldest dropped once the cap is reached. */
const MAX_HANDLES = 500;

type Handle =
  | { type: "locator"; locator: Locator }
  | { type: "coords"; x: number; y: number };

export interface WebSurfaceOptions {
  baseUrl: string;
  /** Replay and discovery run headful so a person can take over the session. */
  headless?: boolean;
  slowMo?: number;
}

function stripLabel(value: string): string {
  return value.trim().replace(/:$/, "").toLowerCase();
}

export class WebSurface implements Surface {
  private readonly handles = new Map<ElementRef, Handle>();
  private refCount = 0;

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    readonly page: Page,
    private readonly baseUrl: string,
  ) {}

  static async launch(options: WebSurfaceOptions): Promise<WebSurface> {
    const browser = await chromium.launch({
      headless: options.headless ?? false,
      slowMo: options.slowMo ?? 0,
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    return new WebSurface(browser, context, page, options.baseUrl.replace(/\/$/, ""));
  }

  /* ── observing ────────────────────────────────────────────────────────── */

  async observe(): Promise<Observation> {
    const frames: FrameObservation[] = [];

    // A frame can detach mid-traversal during a navigation; skip it rather than
    // failing the whole observation.
    const visit = async (frame: Frame, path: string[]): Promise<void> => {
      if (frame.isDetached()) return;
      try {
        frames.push({ path, url: frame.url(), tree: await this.treeOf(frame) });
      } catch {
        return;
      }
      for (const child of frame.childFrames()) {
        await visit(child, [...path, child.name() || "<unnamed>"]);
      }
    };
    await visit(this.page.mainFrame(), []);

    const digest = createHash("sha256");
    for (const frame of frames) digest.update(`${frame.path.join("/")}\n${frame.tree}\n`);

    return {
      url: this.page.url(),
      title: await this.page.title().catch(() => ""),
      frames,
      hash: digest.digest("hex").slice(0, 16),
    };
  }

  /**
   * A frameset document has no body, and ariaSnapshot waits for its element, so
   * each root is checked for existence before one is requested.
   */
  private async treeOf(frame: Frame): Promise<string> {
    for (const root of ["body", ":root"]) {
      const locator = frame.locator(root).first();
      if ((await locator.count().catch(() => 0)) === 0) continue;
      const tree = await locator.ariaSnapshot({ timeout: 2000 }).catch(() => "");
      if (tree.trim()) return tree;
    }
    return "";
  }

  /* ── finding ──────────────────────────────────────────────────────────── */

  async find(
    locator: ElementLocator,
    ctx: BindingContext,
    options: FindOptions = {},
  ): Promise<ElementRef | null> {
    if (locator.kind === "coords") {
      return this.store({ type: "coords", x: locator.x, y: locator.y });
    }

    const frames = options.anyFrame ? this.allFrames() : this.frameFor(locator.framePath);

    for (const frame of frames) {
      const found = await this.locate(frame, locator, ctx);
      if (!found) continue;
      const first = found.first();
      if ((await first.count()) === 0) continue;
      if (!(await first.isVisible().catch(() => false))) continue;
      return this.store({ type: "locator", locator: first });
    }
    return null;
  }

  private allFrames(): Frame[] {
    const all: Frame[] = [];
    const visit = (frame: Frame): void => {
      all.push(frame);
      for (const child of frame.childFrames()) visit(child);
    };
    visit(this.page.mainFrame());
    return all;
  }

  /** The frame at this path, empty if it is not there. Never throws. */
  private frameFor(path: string[]): Frame[] {
    let frame = this.page.mainFrame();
    for (const name of path) {
      const child = frame.childFrames().find((f) => f.name() === name);
      if (!child) return [];
      frame = child;
    }
    return [frame];
  }

  /**
   * `row` narrows a search area; `labelled` and `tableCell` resolve to the
   * element themselves, since the scope already names exactly one thing.
   */
  private async locate(
    frame: Frame,
    locator: ElementLocator,
    ctx: BindingContext,
  ): Promise<Locator | null> {
    const scope: Scope | undefined = locator.scope;
    if (scope?.kind === "labelled") return this.locateLabelled(frame, scope.labelText, ctx);
    if (scope?.kind === "tableCell") return this.locateTableCell(frame, scope, ctx);

    const root: LocatorRoot =
      scope?.kind === "row"
        ? frame.getByRole("row").filter({ hasText: render(scope.containingText, ctx) })
        : frame;

    switch (locator.kind) {
      case "ax": {
        const role = locator.role as PlaywrightRole;
        if (!locator.name) return root.getByRole(role);
        const match = toMatchOption(locator.name, ctx);
        return root.getByRole(role, { name: match.value, exact: match.exact });
      }
      case "text": {
        const match = toMatchOption(locator.text, ctx);
        return root.getByText(match.value, { exact: match.exact });
      }
      case "dom":
        return root.locator(locator.selector);
      default:
        return null;
    }
  }

  /** The control a `<label for>` points at, or the cell following the label. */
  private async locateLabelled(
    frame: Frame,
    labelText: string,
    ctx: BindingContext,
  ): Promise<Locator | null> {
    const text = render(labelText, ctx);

    const label = frame.locator("label").filter({ hasText: text }).first();
    if ((await label.count()) > 0) {
      const controlId = await label.getAttribute("for");
      if (controlId) {
        const control = frame.locator(`[id="${controlId}"]`);
        // A label whose `for` points nowhere falls through to the table layout.
        if ((await control.count()) > 0) return control;
      }
    }

    const row = frame.getByRole("row").filter({ hasText: text }).first();
    if ((await row.count()) === 0) return null;
    const cells = row.getByRole("cell");
    const total = await cells.count();
    for (let i = 0; i < total - 1; i += 1) {
      const cellText = await cells.nth(i).innerText();
      if (stripLabel(cellText) === stripLabel(text)) return cells.nth(i + 1);
    }
    return null;
  }

  /** The cell where a row identified by content meets a column identified by header. */
  private async locateTableCell(
    frame: Frame,
    scope: Extract<Scope, { kind: "tableCell" }>,
    ctx: BindingContext,
  ): Promise<Locator | null> {
    const rowText = render(scope.rowContaining, ctx);
    const headerText = render(scope.columnHeader, ctx);

    const candidates = frame.getByRole("table").filter({ hasText: rowText });
    const tableCount = await candidates.count();

    // Innermost first: a layout table wrapping the data one also contains the
    // row text, and its cells would number differently.
    for (let t = tableCount - 1; t >= 0; t -= 1) {
      const table = candidates.nth(t);
      const column = await this.columnIndex(table, headerText);
      if (column < 0) continue;

      const row = table.getByRole("row").filter({ hasText: rowText }).first();
      if ((await row.count()) === 0) continue;
      const cell = row.getByRole("cell").nth(column);
      if ((await cell.count()) > 0) return cell;
    }
    return null;
  }

  private async columnIndex(table: Locator, headerText: string): Promise<number> {
    const headers = table.getByRole("columnheader");
    const total = await headers.count();
    for (let i = 0; i < total; i += 1) {
      if ((await headers.nth(i).innerText()).trim() === headerText) return i;
    }
    return -1;
  }

  /* ── acting ───────────────────────────────────────────────────────────── */

  async click(ref: ElementRef): Promise<void> {
    const handle = this.handleFor(ref);
    if (handle.type === "coords") {
      await this.page.mouse.click(handle.x, handle.y);
      return;
    }
    await handle.locator.click();
  }

  async fill(ref: ElementRef, text: string, clearFirst: boolean): Promise<void> {
    const locator = this.locatorFor(ref);
    if (clearFirst) {
      await locator.fill(text);
      return;
    }
    await locator.focus();
    await locator.pressSequentially(text);
  }

  async selectOption(ref: ElementRef, value: string): Promise<void> {
    await this.locatorFor(ref).selectOption(value);
  }

  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key);
  }

  async navigate(path: string): Promise<void> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
  }

  /* ── reading ──────────────────────────────────────────────────────────── */

  async textOf(ref: ElementRef): Promise<string> {
    const locator = this.locatorFor(ref);
    const value = await locator.inputValue().catch(() => null);
    if (value !== null) return value.trim();
    return (await locator.innerText()).trim();
  }

  async describe(ref: ElementRef): Promise<string> {
    const handle = this.handleFor(ref);
    if (handle.type === "coords") return `point (${handle.x}, ${handle.y})`;
    // Typed structurally: this package compiles without the DOM library.
    return handle.locator.evaluate(
      (node: { tagName: string; id: string; innerText?: string }) => {
        const id = node.id ? `#${node.id}` : "";
        const label = (node.innerText ?? "").trim().split("\n")[0] ?? "";
        return `${node.tagName.toLowerCase()}${id} "${label.slice(0, 40)}"`;
      },
    );
  }

  async screenshot(): Promise<Buffer> {
    return this.page.screenshot({ fullPage: true });
  }

  async close(): Promise<void> {
    // The browser process must go even if closing the context fails.
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
    this.handles.clear();
  }

  /* ── handles ──────────────────────────────────────────────────────────── */

  private store(handle: Handle): ElementRef {
    this.refCount += 1;
    const ref = `el-${this.refCount}`;
    this.handles.set(ref, handle);
    while (this.handles.size > MAX_HANDLES) {
      const oldest = this.handles.keys().next().value;
      if (oldest === undefined) break;
      this.handles.delete(oldest);
    }
    return ref;
  }

  private handleFor(ref: ElementRef): Handle {
    const handle = this.handles.get(ref);
    if (!handle) throw new Error(`unknown element ref "${ref}"`);
    return handle;
  }

  private locatorFor(ref: ElementRef): Locator {
    const handle = this.handleFor(ref);
    if (handle.type !== "locator") throw new Error(`ref "${ref}" is a point, not an element`);
    return handle.locator;
  }
}
