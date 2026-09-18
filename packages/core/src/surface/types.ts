/**
 * The seam between perceiving and acting on a surface, and the recorded flow.
 *
 * Nothing in this interface names a browser. A desktop adapter implements the
 * same methods against an OS accessibility API.
 */

import type { ElementLocator } from "../artifact/schema.js";
import type { BindingContext } from "./template.js";

/** Opaque handle to something found on the surface. */
export type ElementRef = string;

export interface FrameObservation {
  /** Frame ancestry, outermost first. Empty for the top-level document. */
  path: string[];
  url: string;
  /** Roles and names of what is on screen, as indented text. */
  tree: string;
}

export interface Observation {
  url: string;
  title: string;
  frames: FrameObservation[];
  /** Stable over identical screens; used to detect a run making no progress. */
  hash: string;
}

export interface FindOptions {
  /**
   * Search every frame and ignore the locator's framePath. Ambient outcomes use
   * this: a session timeout or a notice dialog can surface in any frame.
   */
  anyFrame?: boolean;
}

export interface Surface {
  observe(): Promise<Observation>;
  find(
    locator: ElementLocator,
    ctx: BindingContext,
    options?: FindOptions,
  ): Promise<ElementRef | null>;

  click(ref: ElementRef): Promise<void>;
  fill(ref: ElementRef, text: string, clearFirst: boolean): Promise<void>;
  selectOption(ref: ElementRef, value: string): Promise<void>;
  press(key: string): Promise<void>;
  navigate(path: string): Promise<void>;

  textOf(ref: ElementRef): Promise<string>;
  /** Short human-readable identification, for logs and evidence. */
  describe(ref: ElementRef): Promise<string>;

  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
}

const TRUNCATED = "\n… truncated";
const JOINER = "\n\n";

/**
 * Formats an observation for a model or a report, trimmed to a character budget.
 *
 * Every frame keeps a share of the budget rather than the text being cut off at
 * whatever point the budget runs out. A frameset puts navigation first and
 * content last, so cutting from the end drops precisely the frame a failure
 * happened in — and a report whose `observed` is all menu is worse than useless.
 * Room a small frame does not need rolls on to the next.
 */
export function renderObservation(observation: Observation, maxChars: number): string {
  const header = `# ${observation.title}\n${observation.url}\n`;
  const blocks = observation.frames.map((frame) => {
    const name = frame.path.length === 0 ? "<top>" : frame.path.join(" > ");
    return `## frame ${name}  (${frame.url})\n${frame.tree}`;
  });

  const whole = header + blocks.join(JOINER);
  if (whole.length <= maxChars || blocks.length === 0) return whole;

  let room = Math.max(0, maxChars - header.length);
  const kept = blocks.map((block, i) => {
    const share = Math.floor(room / (blocks.length - i));
    const piece =
      block.length <= share
        ? block
        : block.slice(0, Math.max(0, share - TRUNCATED.length)) + TRUNCATED;
    room = Math.max(0, room - piece.length - JOINER.length);
    return piece;
  });

  return header + kept.join(JOINER);
}
