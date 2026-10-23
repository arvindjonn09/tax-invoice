"use client";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  Field,
  FormMessage,
  TextField,
  sendJson,
} from "@/components/form/field";
import { Button } from "@/components/ui/button";

export type Registration = {
  id: string;
  startsOn: string;
  endsOn: string | null;
  basis: "cash" | "non_cash";
};

export type GstSettings = {
  basPeriod: "monthly" | "quarterly";
  registrations: Registration[];
  today: { date: string; registered: boolean; basis: string | null };
};

const BASIS = { cash: "Cash", non_cash: "Non-cash (accruals)" } as const;

const dayFormat = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
export const showDay = (day: string) =>
  dayFormat.format(new Date(`${day}T00:00:00Z`));

/** A tax-affecting change waiting for the user to confirm it. */
type Pending = {
  summary: string;
  url: string;
  method: "POST" | "PATCH";
  body: unknown;
};

/**
 * GST registration history, basis and BAS period. Every change that affects
 * tax is shown back in plain words and needs an explicit confirm.
 */
export function GstSettingsPanel({
  settings,
  editable,
}: {
  settings: GstSettings;
  editable: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const confirmHeading = useRef<HTMLHeadingElement>(null);
  // Controlled from the saved value, so Cancel shows what is really stored.
  // (The page keys this panel by the saved value, so a save resets it.)
  const [basChoice, setBasChoice] = useState(settings.basPeriod);

  function cancel() {
    setPending(null);
    setBasChoice(settings.basPeriod);
  }

  useEffect(() => {
    if (pending) confirmHeading.current?.focus();
  }, [pending]);

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    const result = await sendJson(pending.url, pending.method, pending.body);
    setBusy(false);
    setPending(null);
    if (result.ok) {
      setErrors({});
      setMessage({ kind: "success", text: "GST settings saved." });
      router.refresh();
    } else {
      setErrors(result.fields);
      setMessage({ kind: "error", text: result.message });
      setBasChoice(settings.basPeriod);
    }
  }

  function review(next: Pending) {
    setMessage(null);
    setPending(next);
  }

  function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const startsOn = String(form.get("startsOn") ?? "");
    const endsOn = String(form.get("endsOn") ?? "");
    const basis = String(form.get("basis")) as Registration["basis"];
    const local: Record<string, string> = {};
    if (!startsOn) local.startsOn = "Enter the date registration starts";
    if (endsOn && startsOn && endsOn < startsOn)
      local.endsOn = "The end date must be on or after the start date";
    setErrors(local);
    if (Object.keys(local).length) return;
    review({
      summary: `Registered for GST from ${showDay(startsOn)}${endsOn ? ` to ${showDay(endsOn)}` : " (no end date)"}, accounting on a ${BASIS[basis].toLowerCase()} basis. Invoices dated in this period will charge GST and be titled "Tax Invoice".`,
      url: "/api/company/gst/registrations",
      method: "POST",
      body: { startsOn, endsOn: endsOn || null, basis },
    });
  }

  function onEnd(registration: Registration, form: HTMLFormElement) {
    const endsOn = String(new FormData(form).get("endsOn") ?? "");
    if (!endsOn) {
      setErrors({
        [`end-${registration.id}`]: "Enter the last registered day",
      });
      return;
    }
    review({
      summary: `End GST registration on ${showDay(endsOn)}. Invoices dated after that day will not charge GST and will be titled "Invoice".`,
      url: `/api/company/gst/registrations/${registration.id}`,
      method: "PATCH",
      body: { endsOn },
    });
  }

  function onBasPeriod(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const basPeriod = basChoice;
    review({
      summary: `Report GST ${basPeriod === "monthly" ? "monthly" : "quarterly"} on your BAS.`,
      url: "/api/company/gst",
      method: "PATCH",
      body: { basPeriod },
    });
  }

  const { today } = settings;
  return (
    <div className="space-y-6">
      <p
        className={`rounded-lg p-4 ${today.registered ? "bg-success text-success-foreground" : "bg-warning text-warning-foreground"}`}
      >
        Today ({showDay(today.date)}):{" "}
        <strong>
          {today.registered
            ? `registered for GST, ${BASIS[today.basis as Registration["basis"]].toLowerCase()} basis`
            : "not registered for GST — invoices will not charge GST"}
        </strong>
      </p>

      <FormMessage message={message} />

      {pending ? (
        <section
          aria-labelledby="confirm-heading"
          className="space-y-4 rounded-lg border-2 border-warning-foreground bg-warning p-4 text-warning-foreground"
        >
          <h3
            id="confirm-heading"
            ref={confirmHeading}
            tabIndex={-1}
            className="text-lg font-semibold"
          >
            Confirm this tax setting
          </h3>
          <p>{pending.summary}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={confirm} disabled={busy}>
              {busy ? "Saving…" : "Confirm change"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={cancel}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="history-heading" className="space-y-2">
        <h3 id="history-heading" className="text-lg font-semibold">
          Registration history
        </h3>
        {settings.registrations.length === 0 ? (
          <p className="text-muted-foreground">
            No GST registration recorded. The company is treated as not
            registered: no GST is charged and documents are titled
            &ldquo;Invoice&rdquo;.
          </p>
        ) : (
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Registration history table"
          >
            <table className="w-full min-w-[32rem] text-left">
              <thead>
                <tr className="border-b">
                  <th scope="col" className="py-2 pr-4">
                    From
                  </th>
                  <th scope="col" className="py-2 pr-4">
                    To
                  </th>
                  <th scope="col" className="py-2 pr-4">
                    Basis
                  </th>
                  {editable ? (
                    <th scope="col" className="py-2">
                      End registration
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {settings.registrations.map((registration) => (
                  <tr key={registration.id} className="border-b align-top">
                    <td className="py-2 pr-4">
                      {showDay(registration.startsOn)}
                    </td>
                    <td className="py-2 pr-4">
                      {registration.endsOn
                        ? showDay(registration.endsOn)
                        : "Ongoing"}
                    </td>
                    <td className="py-2 pr-4">{BASIS[registration.basis]}</td>
                    {editable ? (
                      <td className="py-2">
                        {registration.endsOn ? null : (
                          <form
                            className="flex flex-wrap items-end gap-2"
                            onSubmit={(event) => {
                              event.preventDefault();
                              onEnd(registration, event.currentTarget);
                            }}
                          >
                            <TextField
                              id={`end-${registration.id}`}
                              name="endsOn"
                              label="Last registered day"
                              type="date"
                              min={registration.startsOn}
                              error={errors[`end-${registration.id}`]}
                            />
                            <Button type="submit" variant="outline">
                              Review
                            </Button>
                          </form>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editable ? (
        <form onSubmit={onAdd} noValidate className="space-y-4">
          <h3 className="text-lg font-semibold">Add a registration period</h3>
          <p className="text-sm text-muted-foreground">
            To change accounting basis from a date, end the current period the
            day before and add a new period. Periods cannot overlap.
          </p>
          <div className="grid gap-4 md:grid-cols-3">
            <TextField
              id="startsOn"
              label="First registered day"
              type="date"
              required
              error={errors.startsOn}
            />
            <TextField
              id="endsOn"
              label="Last registered day (optional)"
              type="date"
              error={errors.endsOn}
            />
            <Field id="basis" label="Accounting basis" error={errors.basis}>
              {(control) => (
                <select name="basis" defaultValue="cash" {...control}>
                  <option value="cash">{BASIS.cash}</option>
                  <option value="non_cash">{BASIS.non_cash}</option>
                </select>
              )}
            </Field>
          </div>
          <Button type="submit">Review period</Button>
        </form>
      ) : null}

      <form
        onSubmit={onBasPeriod}
        noValidate
        className="flex flex-wrap items-end gap-4"
      >
        <Field id="basPeriod" label="BAS reporting period">
          {(control) => (
            <select
              name="basPeriod"
              value={basChoice}
              onChange={(event) =>
                setBasChoice(event.target.value as GstSettings["basPeriod"])
              }
              disabled={!editable}
              {...control}
            >
              <option value="quarterly">Quarterly</option>
              <option value="monthly">Monthly</option>
            </select>
          )}
        </Field>
        {editable ? (
          <Button type="submit" variant="outline">
            Review BAS period
          </Button>
        ) : null}
      </form>
    </div>
  );
}
