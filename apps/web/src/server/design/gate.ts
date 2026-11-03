import { notFound } from "next/navigation";
import { isProductionEnvironment } from "../auth";

/**
 * The M0 design previews and the design-system sample (#23, #61) are static
 * samples for owner review, with no auth. They are never served in
 * production: a production request gets the same 404 as an unknown path.
 * Development, CI and staging (APP_ENV=staging) still serve them.
 */
export function designPreviewsAvailable(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return !isProductionEnvironment(env);
}

export function requireDesignPreviews(): void {
  if (!designPreviewsAvailable()) notFound();
}
