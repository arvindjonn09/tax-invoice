import { NO_EVIDENCE } from "@jobflow/domain";

/**
 * The small red rectangular "No worker evidence" label (#303). Red is never
 * the only signal: it carries its text, and the danger tokens pass contrast
 * in both themes. Wording lives in NO_EVIDENCE (packages/domain).
 */
export function NoEvidenceLabel() {
  return (
    <span className="inline-flex items-center rounded-sm border border-danger-foreground bg-danger px-2 py-0.5 text-sm font-semibold text-danger-foreground">
      {NO_EVIDENCE.label}
    </span>
  );
}
