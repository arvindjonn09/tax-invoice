import type { ComponentProps, ReactNode } from "react";

const CONTROL =
  "min-h-11 w-full min-w-0 rounded-sm border border-input bg-card px-4 text-card-foreground aria-[invalid=true]:border-danger-foreground";

/**
 * Labelled control with hint and error text wired to aria-describedby, so
 * screen readers announce the error with the field (WCAG 3.3.1).
 */
export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | undefined;
  children: (props: {
    id: string;
    "aria-invalid": boolean;
    "aria-describedby"?: string;
    className: string;
  }) => ReactNode;
}) {
  const described = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {children({
        id,
        "aria-invalid": Boolean(error),
        ...(described ? { "aria-describedby": described } : {}),
        className: CONTROL,
      })}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-danger-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function TextField({
  id,
  label,
  hint,
  error,
  ...input
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | undefined;
} & Omit<ComponentProps<"input">, "id" | "className">) {
  return (
    <Field id={id} label={label} error={error} {...(hint ? { hint } : {})}>
      {(control) => <input name={id} {...control} {...input} />}
    </Field>
  );
}

/** Polite status or assertive error banner for a form's last submit. */
export function FormMessage({
  message,
}: {
  message: { kind: "success" | "error"; text: string } | null;
}) {
  if (!message) return <div aria-live="polite" />;
  return message.kind === "error" ? (
    <p role="alert" className="rounded-lg bg-danger p-4 text-danger-foreground">
      {message.text}
    </p>
  ) : (
    <p
      role="status"
      className="rounded-lg bg-success p-4 text-success-foreground"
    >
      {message.text}
    </p>
  );
}

export type ApiResult =
  | { ok: true; body: unknown }
  | { ok: false; message: string; fields: Record<string, string> };

/** JSON request to our own API; turns 400/403/409/429/500 into readable text. */
export async function sendJson(
  url: string,
  method: "POST" | "PATCH",
  body: unknown,
): Promise<ApiResult> {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => undefined);
  if (!response)
    return {
      ok: false,
      message: "Couldn't reach JobFlow. Check your connection and try again.",
      fields: {},
    };
  const json = (await response.json().catch(() => ({}))) as {
    error?: string;
    fields?: Record<string, string>;
  };
  if (response.ok) return { ok: true, body: json };
  return {
    ok: false,
    message:
      response.status === 403
        ? "You don't have permission to change this."
        : (json.error ?? "Something went wrong. Try again."),
    fields: json.fields ?? {},
  };
}
