"use client";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";

const STATES = ["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"] as const;
const control =
  "min-h-11 rounded-sm border border-input bg-card px-4 text-card-foreground";

type State =
  | { kind: "idle" }
  /** 409 self_service_limit without a company to carry on in (S5 AC5). */
  | { kind: "limit" }
  | { kind: "pending" }
  | { kind: "error"; message: string; fields: Record<string, string> };

function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string | undefined;
  hint?: string;
  children: React.ReactElement<React.ComponentProps<"input">>;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-danger-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const described = (id: string, error?: string, hint?: boolean) =>
  [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") ||
  undefined;

/**
 * Step 1 of onboarding (S5, design §8): the business details, entered once and
 * reused on quotes and invoices. Nothing is kept before submit, in the browser
 * or anywhere else (S5 AC8).
 */
export function Onboarding({ supportEmail }: { supportEmail: string }) {
  const router = useRouter();
  // One key per form load: double clicks and retries return the same company.
  const [key] = useState(() => crypto.randomUUID());
  const [registered, setRegistered] = useState<boolean | null>(null);
  const [state, setState] = useState<State>({ kind: "idle" });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = String(form.get(name) ?? "").trim();
      return value === "" ? null : value;
    };
    setState({ kind: "pending" });
    const response = await fetch("/api/onboarding/company", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({
        businessName: String(form.get("businessName") ?? ""),
        legalName: text("legalName"),
        gstRegistered: registered,
        abn: text("abn"),
        ...(registered
          ? {
              gstStartsOn: text("gstStartsOn") ?? undefined,
              gstBasis: form.get("gstBasis") ?? undefined,
            }
          : {}),
        basPeriod: form.get("basPeriod") ?? "quarterly",
        addressLine1: text("addressLine1"),
        addressLine2: text("addressLine2"),
        suburb: text("suburb"),
        state: text("state"),
        postcode: text("postcode"),
      }),
    }).catch(() => undefined);
    if (response?.status === 201 || response?.status === 200) {
      router.push("/onboarding/details");
      router.refresh();
      return;
    }
    const result = (await response?.json().catch(() => null)) as {
      error?: string;
      fields?: Record<string, string>;
      code?: string;
      alreadyMember?: boolean;
    } | null;
    // Another tab finished first: carry on in that company.
    if (result?.alreadyMember) {
      router.push("/home");
      router.refresh();
      return;
    }
    if (response?.status === 409 && result?.code === "self_service_limit") {
      setState({ kind: "limit" });
      return;
    }
    setState({
      kind: "error",
      message: result?.error ?? "Something went wrong. Try again.",
      fields: result?.fields ?? {},
    });
  }

  async function signOut() {
    await fetch("/api/auth/sign-out", { method: "POST" }).catch(
      () => undefined,
    );
    router.push("/login");
    router.refresh();
  }

  if (state.kind === "limit") {
    return (
      <>
        {/* The form is replaced, so focus moves to the new heading. */}
        <h1
          ref={(heading) => heading?.focus()}
          tabIndex={-1}
          className="text-3xl font-bold tracking-tight"
        >
          You&apos;ve already set up a company
        </h1>
        <p className="mt-4 text-muted-foreground">
          Each account can create one company itself. Contact us to set up
          another company:{" "}
          <a
            href={`mailto:${supportEmail}`}
            className="font-semibold underline [overflow-wrap:anywhere]"
          >
            {supportEmail}
          </a>
          .
        </p>
        <Button
          type="button"
          variant="outline"
          className="mt-8"
          onClick={() => void signOut()}
        >
          Sign out
        </Button>
      </>
    );
  }

  const fields = state.kind === "error" ? state.fields : {};
  return (
    <>
      <p className="text-sm font-medium text-muted-foreground">Step 1 of 2</p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight">
        Set up your business
      </h1>
      <p className="mt-4 text-muted-foreground">
        This creates your company and starts your free 30-day trial. JobFlow
        puts these details on your quotes and tax invoices, and you can change
        them later in Settings.
      </p>
      <p className="mt-4 text-muted-foreground">
        Invited to join a company? Use the invitation link from your owner
        instead.
      </p>
      <section className="mt-8 rounded-2xl border bg-card p-6 text-card-foreground md:p-8">
        <form onSubmit={onSubmit} noValidate className="space-y-6">
          {state.kind === "error" ? (
            <p
              role="alert"
              className="rounded-lg bg-danger p-4 text-danger-foreground"
            >
              {state.message}
            </p>
          ) : null}
          <Field
            id="businessName"
            label="Business name"
            error={fields.businessName}
          >
            <input
              id="businessName"
              name="businessName"
              required
              maxLength={200}
              autoComplete="organization"
              className={control}
              aria-invalid={fields.businessName ? true : undefined}
              aria-describedby={described("businessName", fields.businessName)}
            />
          </Field>
          <Field
            id="legalName"
            label="Legal name (optional)"
            hint="If it differs from your business name."
            error={fields.legalName}
          >
            <input
              id="legalName"
              name="legalName"
              maxLength={200}
              className={control}
              aria-describedby={described("legalName", fields.legalName, true)}
            />
          </Field>
          <fieldset className="space-y-3">
            <legend className="mb-2">Are you registered for GST?</legend>
            {[
              { value: true, label: "Yes, I'm registered for GST" },
              { value: false, label: "No, not registered" },
            ].map((option) => (
              <label
                key={String(option.value)}
                className="flex items-center gap-3"
              >
                <input
                  type="radio"
                  name="gstRegistered"
                  className="size-5"
                  checked={registered === option.value}
                  onChange={() => setRegistered(option.value)}
                />
                {option.label}
              </label>
            ))}
            {fields.gstRegistered ? (
              <p className="text-sm text-danger-foreground">
                {fields.gstRegistered}
              </p>
            ) : null}
          </fieldset>
          <Field
            id="abn"
            label={registered ? "ABN" : "ABN (optional)"}
            hint="11 digits, spaces are fine."
            error={fields.abn}
          >
            <input
              id="abn"
              name="abn"
              inputMode="numeric"
              maxLength={14}
              className={control}
              aria-invalid={fields.abn ? true : undefined}
              aria-describedby={described("abn", fields.abn, true)}
            />
          </Field>
          {registered ? (
            <>
              <Field
                id="gstStartsOn"
                label="GST registration date"
                error={fields.gstStartsOn}
              >
                <input
                  id="gstStartsOn"
                  name="gstStartsOn"
                  type="date"
                  className={control}
                  aria-invalid={fields.gstStartsOn ? true : undefined}
                  aria-describedby={described(
                    "gstStartsOn",
                    fields.gstStartsOn,
                  )}
                />
              </Field>
              <div className="flex flex-col gap-2">
                <label htmlFor="gstBasis">GST accounting basis</label>
                <select
                  id="gstBasis"
                  name="gstBasis"
                  className={control}
                  defaultValue=""
                >
                  <option value="" disabled>
                    Choose…
                  </option>
                  <option value="cash">Cash</option>
                  <option value="non_cash">Accruals (non-cash)</option>
                </select>
                {fields.gstBasis ? (
                  <p className="text-sm text-danger-foreground">
                    {fields.gstBasis}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-col gap-2">
                <label htmlFor="basPeriod">BAS reporting period</label>
                <select
                  id="basPeriod"
                  name="basPeriod"
                  className={control}
                  defaultValue="quarterly"
                >
                  <option value="quarterly">Quarterly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </div>
            </>
          ) : null}
          <fieldset className="space-y-4">
            <legend className="mb-2 font-semibold">
              Business address (optional)
            </legend>
            <Field
              id="addressLine1"
              label="Street address"
              error={fields.addressLine1}
            >
              <input
                id="addressLine1"
                name="addressLine1"
                maxLength={200}
                autoComplete="address-line1"
                className={control}
              />
            </Field>
            <Field
              id="addressLine2"
              label="Address line 2"
              error={fields.addressLine2}
            >
              <input
                id="addressLine2"
                name="addressLine2"
                maxLength={200}
                autoComplete="address-line2"
                className={control}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field id="suburb" label="Suburb" error={fields.suburb}>
                <input
                  id="suburb"
                  name="suburb"
                  maxLength={100}
                  autoComplete="address-level2"
                  className={control}
                />
              </Field>
              <div className="flex flex-col gap-2">
                <label htmlFor="state">State</label>
                <select
                  id="state"
                  name="state"
                  className={control}
                  defaultValue=""
                >
                  <option value="">—</option>
                  {STATES.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
              </div>
              <Field id="postcode" label="Postcode" error={fields.postcode}>
                <input
                  id="postcode"
                  name="postcode"
                  inputMode="numeric"
                  maxLength={4}
                  autoComplete="postal-code"
                  className={control}
                  aria-invalid={fields.postcode ? true : undefined}
                  aria-describedby={described("postcode", fields.postcode)}
                />
              </Field>
            </div>
          </fieldset>
          <Button
            type="submit"
            className="w-full"
            disabled={state.kind === "pending"}
          >
            {state.kind === "pending"
              ? "Setting up your business…"
              : "Create my business and start the free trial"}
          </Button>
        </form>
      </section>
    </>
  );
}
