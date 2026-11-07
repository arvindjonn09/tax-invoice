import type { ComponentProps } from "react";

const inputClass =
  "min-h-11 rounded-sm border border-input bg-card px-4 text-card-foreground";

/** A labelled input with linked help and error text (signup-trial.md, Forms). */
export function AccountField({
  id,
  label,
  error,
  hint,
  ...input
}: {
  id: string;
  label: string;
  error?: string | undefined;
  hint?: string;
} & ComponentProps<"input">) {
  const described = [hint && `${id}-hint`, error && `${id}-error`]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <input
        id={id}
        name={id}
        className={inputClass}
        aria-invalid={error ? true : undefined}
        aria-describedby={described || undefined}
        {...input}
      />
      {error ? (
        <p id={`${id}-error`} className="text-sm text-danger-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The error summary: a heading that takes focus, one link per field. */
export function ProblemSummary({
  message,
  fields,
  labels,
}: {
  message: string;
  fields: Record<string, string>;
  labels: Record<string, string>;
}) {
  const entries = Object.entries(fields);
  return (
    <div
      role="alert"
      className="rounded-lg bg-danger p-4 text-danger-foreground"
    >
      <h2 tabIndex={-1} className="font-semibold" ref={(node) => node?.focus()}>
        There&apos;s a problem
      </h2>
      {entries.length ? (
        <ul className="mt-2 list-disc pl-6">
          {entries.map(([field, text]) => (
            <li key={field}>
              <a className="underline" href={`#${field}`}>
                {labels[field] ? `${labels[field]}: ` : ""}
                {text}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2">{message}</p>
      )}
    </div>
  );
}
