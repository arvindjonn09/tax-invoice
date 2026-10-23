import type { ReactNode } from "react";

/** Honest empty state: says what's missing, never shows invented records. */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <section className="space-y-2 rounded-lg border bg-card p-6 text-card-foreground">
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="text-muted-foreground">{description}</p>
      {action}
    </section>
  );
}

/** Recoverable error without internal details or sensitive identifiers. */
export function ErrorState({
  title,
  message,
  reference,
  retry,
}: {
  title: string;
  message: string;
  reference?: string;
  retry?: ReactNode;
}) {
  return (
    <section
      role="alert"
      className="space-y-2 rounded-lg border bg-danger p-6 text-danger-foreground"
    >
      <h2 className="text-xl font-semibold">{title}</h2>
      <p>{message}</p>
      {reference ? <p className="text-sm">Reference: {reference}</p> : null}
      {retry}
    </section>
  );
}
