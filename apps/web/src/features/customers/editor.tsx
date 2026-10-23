"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Field,
  FormMessage,
  TextField,
  sendJson,
} from "@/components/form/field";
import {
  AUSTRALIAN_STATES,
  abnField,
  emailField,
  phoneField,
  postcodeField,
} from "@/server/http/fields";
import type { Contact, Customer, Location } from "./remote";
type Kind = "customer" | "contact" | "location";
const fields: Record<
  Kind,
  {
    key: string;
    label: string;
    required?: boolean;
    max: number;
    type?: string;
  }[]
> = {
  customer: [
    { key: "name", label: "Customer name", required: true, max: 200 },
    { key: "abn", label: "ABN", max: 20 },
    { key: "billingEmail", label: "Billing email", max: 320, type: "email" },
    { key: "billingPhone", label: "Billing phone", max: 30, type: "tel" },
    { key: "addressLine1", label: "Billing street address", max: 200 },
    { key: "addressLine2", label: "Billing address line 2", max: 200 },
    { key: "suburb", label: "Billing suburb", max: 100 },
    { key: "postcode", label: "Billing postcode", max: 4 },
  ],
  contact: [
    { key: "name", label: "Contact name", required: true, max: 200 },
    { key: "position", label: "Position", max: 100 },
    { key: "email", label: "Contact email", max: 320, type: "email" },
    { key: "phone", label: "Contact phone", max: 30, type: "tel" },
  ],
  location: [
    { key: "label", label: "Site label", max: 100 },
    { key: "addressLine1", label: "Street address", required: true, max: 200 },
    { key: "addressLine2", label: "Address line 2", max: 200 },
    { key: "suburb", label: "Suburb", required: true, max: 100 },
    { key: "postcode", label: "Postcode", required: true, max: 4 },
    { key: "accessNotes", label: "Access notes", max: 300 },
  ],
};
export function Editor({
  kind,
  url,
  initial,
  onSaved,
  onCancel,
}: {
  kind: Kind;
  url: string;
  initial?: Customer | Contact | Location;
  onSaved: (body: unknown) => void;
  onCancel: () => void;
}) {
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{
    kind: "error";
    text: string;
  } | null>(null);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    const navigate = (event: MouseEvent) => {
      const link = (event.target as Element).closest?.("a[href]");
      if (link && !window.confirm("Discard unsaved changes?")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", navigate, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", navigate, true);
    };
  }, [dirty]);
  const values = initial as unknown as
    Record<string, string | boolean | null> | undefined;
  return (
    <form
      className="space-y-4"
      onChange={() => setDirty(true)}
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        const form = new FormData(event.currentTarget);
        const body: Record<string, unknown> = {};
        for (const field of fields[kind])
          body[field.key] =
            (form.get(field.key) as string).trim() ||
            (field.required ? "" : null);
        if (kind !== "contact") body.state = form.get("state") || null;
        if (kind === "contact") body.isPrimary = form.get("isPrimary") === "on";
        const validation: Record<string, string> = {};
        for (const [key, rule] of Object.entries({
          abn: abnField,
          billingEmail: emailField,
          email: emailField,
          billingPhone: phoneField,
          phone: phoneField,
          postcode: postcodeField.nullable(),
        })) {
          if (!(key in body)) continue;
          const checked = rule.safeParse(body[key]);
          if (!checked.success)
            validation[key] =
              checked.error.issues[0]?.message ?? "Check this field";
        }
        if (Object.keys(validation).length) {
          setErrors(validation);
          setMessage({ kind: "error", text: "Check the highlighted fields." });
          document
            .getElementById(`${kind}-${Object.keys(validation)[0]}`)
            ?.focus();
          return;
        }
        setBusy(true);
        setErrors({});
        setMessage(null);
        const result = await sendJson(url, initial ? "PATCH" : "POST", body);
        setBusy(false);
        if (!result.ok) {
          setErrors(result.fields);
          setMessage({ kind: "error", text: result.message });
          return;
        }
        setDirty(false);
        onSaved(result.body);
      }}
    >
      <p className="text-sm text-muted-foreground">
        Fields marked * are required.
      </p>
      <fieldset disabled={busy} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <legend className="sr-only">
          {initial ? "Edit" : "Add"} {kind}
        </legend>
        {fields[kind].map((field) => (
          <TextField
            key={field.key}
            id={`${kind}-${field.key}`}
            name={field.key}
            label={`${field.label}${field.required ? " *" : ""}`}
            required={field.required}
            maxLength={field.max}
            type={field.type ?? "text"}
            defaultValue={String(values?.[field.key] ?? "")}
            error={errors[field.key]}
            {...(field.key === "postcode"
              ? { pattern: "[0-9]{4}", inputMode: "numeric" as const }
              : {})}
          />
        ))}
        {kind !== "contact" ? (
          <Field
            id={`${kind}-state`}
            label={`${kind === "customer" ? "Billing state" : "State *"}`}
            error={errors.state}
          >
            {(control) => (
              <select
                {...control}
                name="state"
                required={kind === "location"}
                defaultValue={String(values?.state ?? "")}
              >
                <option value="">Select state</option>
                {AUSTRALIAN_STATES.map((state) => (
                  <option key={state}>{state}</option>
                ))}
              </select>
            )}
          </Field>
        ) : (
          <label className="flex min-h-11 items-center gap-3">
            <input
              type="checkbox"
              name="isPrimary"
              defaultChecked={Boolean(values?.isPrimary)}
              className="size-5"
            />
            Primary contact
          </label>
        )}
      </fieldset>
      <FormMessage message={message} />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => {
            if (!dirty || window.confirm("Discard unsaved changes?"))
              onCancel();
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
