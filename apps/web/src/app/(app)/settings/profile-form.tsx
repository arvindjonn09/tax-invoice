"use client";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import {
  Field,
  FormMessage,
  TextField,
  sendJson,
} from "@/components/form/field";
import { Button } from "@/components/ui/button";

export type Profile = {
  name: string;
  legalName: string | null;
  abn: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  invoicePrefix: string;
  jobPrefix: string;
};

const STATES = ["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"];

const formatAbn = (digits: string | null) =>
  digits
    ? `${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`
    : "";

/** Company profile and numbering. Owners edit; others see it read-only. */
export function ProfileForm({
  profile,
  editable,
}: {
  profile: Profile;
  editable: boolean;
}) {
  const router = useRouter();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "");
    setPending(true);
    const result = await sendJson("/api/company", "PATCH", {
      name: text("name"),
      legalName: text("legalName"),
      abn: text("abn"),
      addressLine1: text("addressLine1"),
      addressLine2: text("addressLine2"),
      suburb: text("suburb"),
      state: text("state") || null,
      postcode: text("postcode") || null,
      invoicePrefix: text("invoicePrefix"),
      jobPrefix: text("jobPrefix"),
    });
    setPending(false);
    if (result.ok) {
      setErrors({});
      setMessage({ kind: "success", text: "Company details saved." });
      router.refresh();
    } else {
      setErrors(result.fields);
      setMessage({ kind: "error", text: result.message });
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6">
      <FormMessage message={message} />
      <fieldset disabled={!editable} className="space-y-4">
        <legend className="sr-only">Company profile</legend>
        <div className="grid gap-4 md:grid-cols-2">
          <TextField
            id="name"
            label="Trading name"
            defaultValue={profile.name}
            required
            maxLength={200}
            error={errors.name}
          />
          <TextField
            id="legalName"
            label="Legal name"
            hint="As registered with the ABR"
            defaultValue={profile.legalName ?? ""}
            maxLength={200}
            error={errors.legalName}
          />
          <TextField
            id="abn"
            label="ABN"
            hint="11 digits, spaces allowed. Printed on tax invoices."
            defaultValue={formatAbn(profile.abn)}
            inputMode="numeric"
            autoComplete="off"
            error={errors.abn}
          />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <TextField
            id="addressLine1"
            label="Address line 1"
            defaultValue={profile.addressLine1 ?? ""}
            autoComplete="address-line1"
            error={errors.addressLine1}
          />
          <TextField
            id="addressLine2"
            label="Address line 2 (optional)"
            defaultValue={profile.addressLine2 ?? ""}
            autoComplete="address-line2"
            error={errors.addressLine2}
          />
          <TextField
            id="suburb"
            label="Suburb"
            defaultValue={profile.suburb ?? ""}
            autoComplete="address-level2"
            error={errors.suburb}
          />
          <div className="grid grid-cols-2 gap-4">
            <Field id="state" label="State" error={errors.state}>
              {(control) => (
                <select
                  name="state"
                  defaultValue={profile.state ?? ""}
                  {...control}
                >
                  <option value="">—</option>
                  {STATES.map((state) => (
                    <option key={state}>{state}</option>
                  ))}
                </select>
              )}
            </Field>
            <TextField
              id="postcode"
              label="Postcode"
              defaultValue={profile.postcode ?? ""}
              inputMode="numeric"
              autoComplete="postal-code"
              maxLength={4}
              error={errors.postcode}
            />
          </div>
        </div>
        <h3 className="text-lg font-semibold">Numbering</h3>
        <div className="grid gap-4 md:grid-cols-2">
          <TextField
            id="invoicePrefix"
            label="Invoice number prefix"
            hint="e.g. INV- gives INV-0001"
            defaultValue={profile.invoicePrefix}
            maxLength={10}
            error={errors.invoicePrefix}
          />
          <TextField
            id="jobPrefix"
            label="Job number prefix"
            hint="e.g. JOB- gives JOB-0001"
            defaultValue={profile.jobPrefix}
            maxLength={10}
            error={errors.jobPrefix}
          />
        </div>
        {editable ? (
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save company details"}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            Only the owner can change company details.
          </p>
        )}
      </fieldset>
    </form>
  );
}
