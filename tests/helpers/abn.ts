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
