"use client";
import { useState } from "react";
import {
  TextField,
  Field,
  FormMessage,
  sendJson,
} from "@/components/form/field";
import { useUnsavedChanges } from "@/components/form/use-unsaved-changes";
import { Button } from "@/components/ui/button";
import type { Contractor } from "./types";
export function ContractorEditor({
  initial,
  saved,
  cancel,
}: {
  initial?: Contractor;
  saved: (row: Contractor) => void;
  cancel: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<{
    kind: "error";
    text: string;
  } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useUnsavedChanges(dirty);
  return (
    <form
      className="space-y-4"
      onChange={() => setDirty(true)}
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        const form = new FormData(event.currentTarget);
        const optional = (name: string) =>
          String(form.get(name) ?? "").trim() || null;
        setBusy(true);
        const result = await sendJson(
          `/api/contractors${initial ? `/${initial.id}` : ""}`,
          initial ? "PATCH" : "POST",
          {
            name: form.get("name"),
            abn: optional("abn"),
            email: optional("email"),
            phone: optional("phone"),
            gstRegistered: form.get("gstRegistered") === "yes",
          },
        );
        setBusy(false);
        if (!result.ok) {
          setErrors(result.fields);
          setMessage({ kind: "error", text: result.message });
          return;
        }
        setDirty(false);
        saved(result.body as Contractor);
      }}
    >
      <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
        <legend className="sr-only">Contractor details</legend>
        <TextField
          id="contractor-name"
          name="name"
          label="Contractor name *"
          required
          maxLength={200}
          defaultValue={initial?.name}
          error={errors.name}
        />
        <TextField
          id="contractor-abn"
          name="abn"
          label="ABN"
          hint="Required when registered for GST."
          maxLength={20}
          defaultValue={initial?.abn ?? ""}
          error={errors.abn}
        />
        <Field
          id="contractor-gst"
          label="Registered for GST"
          error={errors.gstRegistered}
        >
          {(control) => (
            <select
              {...control}
              name="gstRegistered"
              defaultValue={initial?.gstRegistered ? "yes" : "no"}
            >
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          )}
        </Field>
        <TextField
          id="contractor-email"
          name="email"
          label="Email"
          type="email"
          maxLength={254}
          defaultValue={initial?.email ?? ""}
          error={errors.email}
        />
        <TextField
          id="contractor-phone"
          name="phone"
          label="Phone"
          maxLength={30}
          defaultValue={initial?.phone ?? ""}
          error={errors.phone}
        />
      </fieldset>
      <FormMessage message={message} />
      <div className="flex flex-wrap gap-3">
        <Button disabled={busy} type="submit">
          {busy ? "Saving…" : "Save contractor"}
        </Button>
        <Button
          disabled={busy}
          type="button"
          variant="outline"
          onClick={() => {
            if (!dirty || window.confirm("Discard unsaved changes?")) cancel();
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
