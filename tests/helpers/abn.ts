import { isValidAbn } from "../../packages/domain/src/index";

/**
 * Synthetic ABNs only (AGENTS.md: no real ABNs): choose the two leading
 * digits that make a made-up 9-digit body pass the checksum.
 */
export function syntheticAbn(body: string): string {
  for (let lead = 10; lead <= 99; lead += 1) {
    const candidate = `${lead}${body}`;
    if (isValidAbn(candidate)) return candidate;
  }
  throw new Error(`No checksum lead for ${body}`);
}

/** A made-up address; every company needs one before it can issue an invoice. */
export const SYNTHETIC_ADDRESS = {
  addressLine1: "1 Synthetic Road",
  suburb: "Testville",
  state: "NSW",
  postcode: "2000",
} as const;
