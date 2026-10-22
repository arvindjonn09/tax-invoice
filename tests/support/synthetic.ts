// Pure, deterministic synthetic values. Never use real names, ABNs or addresses.

/** Fixed reference instant for tests that need "now" (pair with vi.useFakeTimers). */
export const REFERENCE_INSTANT = new Date("2026-07-01T00:00:00.000Z");

const SCOPE = /^[a-z][a-z0-9-]{0,30}$/;

/** A scope keeps parallel test files from colliding inside one isolated database. */
export function assertScope(scope: string): string {
  if (!SCOPE.test(scope)) {
    throw new Error(`Invalid synthetic scope "${scope}"`);
  }
  return scope;
}

/** `.test` is a reserved TLD (RFC 2606): these addresses can never reach a real inbox. */
export function syntheticEmail(scope: string, sequence: number): string {
  return `${assertScope(scope)}-user-${sequence}@example.test`;
}

export function syntheticCompanyName(scope: string, sequence: number): string {
  return `Sample Company ${assertScope(scope)} ${sequence}`;
}

export function syntheticPersonName(scope: string, sequence: number): string {
  return `Sample Person ${assertScope(scope)} ${sequence}`;
}

/** Deterministic counter: the same scope always yields the same sequence. */
export function createSequence(): () => number {
  let current = 0;
  return () => {
    current += 1;
    return current;
  };
}
