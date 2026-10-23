"use client";
import { useState } from "react";
import {
  Field,
  TextField,
  FormMessage,
  sendJson,
} from "@/components/form/field";
import { useUnsavedChanges } from "@/components/form/use-unsaved-changes";
import { useRemote } from "@/components/data/use-remote";
import { Button } from "@/components/ui/button";
import { audInput, parseAudInput } from "@/lib/aud-input";
import { EntityPicker } from "./picker";
import type { Job } from "./types";
type Site = {
  id: string;
  label: string | null;
  addressLine1: string;
  archivedAt: string | null;
};
export function JobEditor({
  initial,
  onSaved,
  onCancel,
}: {
  initial?: Job;
  onSaved: (job: Job) => void;
  onCancel: () => void;
}) {
  const [customerId, setCustomerId] = useState(initial?.customerId ?? "");
  const [locationId, setLocationId] = useState(initial?.locationId ?? "");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{
    kind: "error";
    text: string;
  } | null>(null);
  useUnsavedChanges(dirty);
  const {
    data: customer,
    error: siteError,
    reload,
  } = useRemote<{ name: string; locations: Site[] }>(
    customerId ? `/api/customers/${customerId}` : null,
  );
  const sites =
    customer?.locations.filter(
      (site) => !site.archivedAt || site.id === locationId,
    ) ?? [];
  return (
    <form
      className="space-y-4"
      onChange={(event) => {
        if (!(event.target as Element).closest("[data-filter]")) setDirty(true);
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        const form = new FormData(event.currentTarget);
        const nextErrors: Record<string, string> = {};
        let amount: string | null = null;
        try {
          amount = parseAudInput(String(form.get("price") ?? ""));
        } catch (error) {
          nextErrors.agreedPriceExclusiveCents = (error as Error).message;
        }
        if (!customerId) nextErrors.customerId = "Choose a customer";
        const title = String(form.get("title") ?? "").trim();
        if (!title) nextErrors.title = "Enter a job title";
        setErrors(nextErrors);
        if (Object.keys(nextErrors).length) {
          setMessage({ kind: "error", text: "Check the highlighted fields." });
          return;
        }
        const body = {
          title,
          description: String(form.get("description") ?? "").trim() || null,
          dueOn: form.get("dueOn") || null,
          agreedPriceExclusiveCents: amount,
          ...(!initial
            ? { customerId, locationId: locationId || null }
            : locationId !== (initial.locationId ?? "")
              ? { locationId: locationId || null }
              : {}),
        };
        setBusy(true);
        setMessage(null);
        const result = await sendJson(
          initial ? `/api/jobs/${initial.id}` : "/api/jobs",
          initial ? "PATCH" : "POST",
          body,
        );
        setBusy(false);
        if (!result.ok) {
          setErrors(result.fields);
          setMessage({ kind: "error", text: result.message });
          return;
        }
        setDirty(false);
        onSaved(result.body as Job);
      }}
    >
      <p className="text-sm text-muted-foreground">
        Fields marked * are required. Agreed price is AUD excluding GST.
      </p>
      <fieldset disabled={busy} className="space-y-4">
        <legend className="sr-only">Job details</legend>
        <TextField
          id="job-title"
          name="title"
          label="Job title *"
          required
          maxLength={200}
          defaultValue={initial?.title}
          error={errors.title}
        />
        {initial ? (
          <p>
            Customer: {customer?.name ?? "Loading customer…"}. The customer is
            fixed after creation.
          </p>
        ) : (
          <EntityPicker
            kind="customers"
            id="job-customer"
            label="Customer *"
            value={customerId}
            onChange={(id) => {
              setCustomerId(id);
              setLocationId("");
              setDirty(true);
            }}
            error={errors.customerId}
          />
        )}
        <Field id="job-site" label="Job site" error={errors.locationId}>
          {(control) => (
            <select
              {...control}
              value={locationId}
              disabled={!customerId || !customer}
              onChange={(event) => setLocationId(event.target.value)}
            >
              <option value="">No site selected</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.label || site.addressLine1}
                  {site.archivedAt ? " (archived)" : ""}
                </option>
              ))}
            </select>
          )}
        </Field>
        {siteError ? (
          <div role="alert">
            <p>{siteError}</p>
            <Button type="button" variant="outline" onClick={reload}>
              Retry sites
            </Button>
          </div>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="job-due"
            name="dueOn"
            label="Due date"
            type="date"
            defaultValue={initial?.dueOn ?? ""}
            error={errors.dueOn}
          />
          <TextField
            id="job-price"
            name="price"
            label="Agreed price (AUD ex GST)"
            inputMode="decimal"
            hint="Optional. Enter dollars excluding GST, for example 2500.00. Tax is handled on invoices."
            defaultValue={audInput(initial?.agreedPriceExclusiveCents)}
            error={errors.agreedPriceExclusiveCents}
          />
        </div>
        <Field
          id="job-description"
          label="Work description"
          error={errors.description}
        >
          {(control) => (
            <textarea
              {...control}
              name="description"
              maxLength={4000}
              rows={4}
              defaultValue={initial?.description ?? ""}
              className={`${control.className} py-3`}
            />
          )}
        </Field>
      </fieldset>
      <FormMessage message={message} />
      <div className="flex flex-wrap gap-3">
        <Button disabled={busy} type="submit">
          {busy ? "Saving…" : "Save job"}
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
