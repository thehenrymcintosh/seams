// Generated from the plan. Edit the plan, not this file.

/** The current time, so tests can pin it. Adapters: prod SystemClock, test FixedClock. */
export interface Clock {
  /** now() */
  now(...args: unknown[]): Promise<unknown>;
}
