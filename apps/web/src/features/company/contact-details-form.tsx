"use client";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState } from "react";
import {
  Field,
  FormMessage,
  TextField,
  sendJson,
} from "@/components/form/field";
import { ReadOnlyNotice, useWritable } from "@/components/shell/company-access";
import { Button } from "@/components/ui/button";

export type ContactDetails = {
  phone: string | null;
  businessEmail: string | null;
  website: string | null;
  about: string | null;
};

const ABOUT_LIMIT = 1000;

/** The organisation's contact details and description (S6). */
export function ContactDetailsForm({
  details,
  editable: allowed,
  submitLabel = "Save contact details",
  afterSave,
  secondary,
}: {
  details: ContactDetails;
  editable: boolean;
  submitLabel?: string;
  /** Where to go once saved; stays on the page if unset. */
  afterSave?: string;
  secondary?: ReactNode;
}) {
  const editable = useWritable(allowed);
  const router = useRouter();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [about, setAbout] = useState(details.about ?? "");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "");
    setPending(true);
    const result = await sendJson("/api/company", "PATCH", {
      phone: text("phone"),
      businessEmail: text("businessEmail"),
      website: text("website"),
      about: text("about"),
    });
    setPending(false);
    if (!result.ok) {
      setErrors(result.fields);
      setMessage({ kind: "error", text: result.message });
      return;
    }
    setErrors({});
    if (afterSave) {
      router.push(afterSave);
    } else {
      setMessage({ kind: "success", text: "Contact details saved." });
    }
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6">
      <FormMessage message={message} />
      {allowed ? <ReadOnlyNotice /> : null}
      <fieldset disabled={!editable} className="space-y-4">
        <legend className="sr-only">Contact details</legend>
        <div className="grid gap-4 md:grid-cols-2">
          <TextField
            id="phone"
            label="Phone"
            type="tel"
            autoComplete="tel"
            maxLength={20}
            defaultValue={details.phone ?? ""}
            error={errors.phone}
          />
          <TextField
            id="businessEmail"
            label="Business email"
            hint="Shown on documents. It isn't used to sign in."
            type="email"
            maxLength={320}
            defaultValue={details.businessEmail ?? ""}
            error={errors.businessEmail}
          />
          <TextField
            id="website"
            label="Website"
            type="url"
            maxLength={200}
            placeholder="https://"
            defaultValue={details.website ?? ""}
            error={errors.website}
          />
        </div>
        <Field
          id="about"
          label="About your business"
          hint={`${about.length} of ${ABOUT_LIMIT} characters`}
          error={errors.about}
        >
          {({ className, ...control }) => (
            <textarea
              name="about"
              rows={5}
              maxLength={ABOUT_LIMIT}
              value={about}
              onChange={(event) => setAbout(event.target.value)}
              className={`${className} py-2`}
              {...control}
            />
          )}
        </Field>
        {editable ? (
          <div className="flex flex-wrap gap-4">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : submitLabel}
            </Button>
            {secondary}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Only the owner can change contact details.
          </p>
        )}
      </fieldset>
    </form>
  );
}
