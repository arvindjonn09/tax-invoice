import type { Actor } from "./guard";
import { type Permission, can } from "./policy";

/**
 * A positive field allowlist: each field is either visible to everyone who
 * may read the record (`true`) or only to roles holding a permission.
 * Fields not listed are never returned (secure by default for new columns).
 */
export type FieldRules<T> = { readonly [K in keyof T]?: true | Permission };

/**
 * Project a record down to the fields this actor may see. Use it on every
 * server response, page prop and export so hidden prices, profit and cost
 * rates never reach the client (threat model T03).
 */
export function visibleFields<T extends object>(
  actor: Actor,
  record: T,
  rules: FieldRules<T>,
): Partial<T> {
  const visible: Partial<T> = {};
  for (const key of Object.keys(rules) as (keyof T)[]) {
    const rule = rules[key];
    if (rule === true || (rule !== undefined && can(actor.role, rule))) {
      if (key in record) visible[key] = record[key];
    }
  }
  return visible;
}
