/** Runtime faults the fixture can be told to inject on the next content render. */

export const chaosModes = [
  "none",
  "session_expired",
  "notice",
  "slow_load",
  "permission_denied",
  "app_error",
] as const;

export type ChaosMode = (typeof chaosModes)[number];

export function isChaosMode(value: string): value is ChaosMode {
  return (chaosModes as readonly string[]).includes(value);
}

export interface ChaosState {
  mode: ChaosMode;
  /** Remaining renders the mode applies to. Zero means inactive. */
  remaining: number;
}

export function armed(): ChaosState {
  return { mode: "none", remaining: 0 };
}

export function arm(state: ChaosState, mode: ChaosMode, times: number): void {
  state.mode = mode;
  state.remaining = mode === "none" ? 0 : times;
}

/** Returns the mode to apply now and decrements the remaining count. */
export function consume(state: ChaosState): ChaosMode {
  if (state.remaining <= 0) return "none";
  state.remaining -= 1;
  const mode = state.mode;
  if (state.remaining === 0) state.mode = "none";
  return mode;
}
