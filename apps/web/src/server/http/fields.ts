import { isValidAbn, normaliseAbn } from "@jobflow/domain";
import { z } from "zod";

/** Shared Zod field rules so every form validates the same way. */

export const AUSTRALIAN_STATES = [
  "ACT",
  "NSW",
  "NT",
  "QLD",
  "SA",
  "TAS",
  "VIC",
  "WA",
] as const;

/** Trimmed text; empty or null clears the field (stored as null). */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => (value ? value : null));

export const requiredText = (max: number, message = "Required") =>
  z.string().trim().min(1, message).max(max);

/** Optional ABN: spaces allowed, ATO checksum required, stored as 11 digits. */
export const abnField = z
  .string()
  .nullable()
  .transform((value, context) => {
    if (value === null || value.trim() === "") return null;
    const digits = normaliseAbn(value);
    if (!digits || !isValidAbn(digits)) {
      context.addIssue({
        code: "custom",
        message: "Enter a valid 11-digit ABN",
      });
      return z.NEVER;
    }
    return digits;
  });

export const emailField = optionalText(320).refine(
  (value) => value === null || z.email().safeParse(value).success,
  "Enter a valid email address",
);

export const phoneField = optionalText(30).refine(
  (value) => value === null || /^[+\d][\d\s()-]*$/.test(value),
  "Use digits, spaces, +, - or brackets",
);

export const stateField = z.enum(AUSTRALIAN_STATES, {
  error: "Choose a state or territory",
});

export const postcodeField = z
  .string()
  .trim()
  .regex(/^\d{4}$/, "Enter a 4-digit postcode");

/** Drop keys whose value is undefined (exactOptionalPropertyTypes). */
export function defined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as { [K in keyof T]: Exclude<T[K], undefined> };
}

/** A route id that is a UUID, or null (looked up as "not found" → 404). */
export function uuidOrNull(id: string): string | null {
  return z.uuid().safeParse(id).success ? id : null;
}
