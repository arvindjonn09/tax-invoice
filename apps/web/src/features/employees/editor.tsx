"use client";
import { useState } from "react";
import {
  TextField,
  Field,
  FormMessage,
  sendJson,
} from "@/components/form/field";
import { useRemote } from "@/components/data/use-remote";
import { useUnsavedChanges } from "@/components/form/use-unsaved-changes";
import { Button } from "@/components/ui/button";
import type { Employee, LinkableUser } from "./types";

/**
 * Create or edit an employee record. Linking a login is offered only to
 * roles that may write employees; the list holds employee-role accounts not
 * linked to another record. Leaving the picker untouched never unlinks.
 */
export function EmployeeEditor({
  initial,
  saved,
  cancel,
}: {
  initial?: Employee;
  saved: (row: Employee) => void;
  cancel: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<{
    kind: "error";
    text: string;
  } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const logins = useRemote<{ users: LinkableUser[] }>(
    "/api/employees/linkable-users",
  );
  useUnsavedChanges(dirty);
  const choices =
    logins.data?.users.filter(
      (user) => !user.employeeId || user.employeeId === initial?.id,
    ) ?? [];
  // A login of another role linked earlier stays selectable so an edit
  // doesn't silently drop it.
  const keepsOther =
    initial?.userId &&
    logins.data &&
    !choices.some((user) => user.userId === initial.userId);
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
          `/api/employees${initial ? `/${initial.id}` : ""}`,
          initial ? "PATCH" : "POST",
          {
            name: form.get("name"),
            email: optional("email"),
            phone: optional("phone"),
            ...(logins.data ? { userId: optional("userId") } : {}),
          },
        );
        setBusy(false);
        if (!result.ok) {
          setErrors(result.fields);
          setMessage({ kind: "error", text: result.message });
          return;
        }
        setDirty(false);
        saved(result.body as Employee);
      }}
    >
      <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
        <legend className="sr-only">Employee details</legend>
        <TextField
          id="employee-name"
          name="name"
          label="Employee name *"
          required
          maxLength={200}
          defaultValue={initial?.name}
          error={errors.name}
        />
        <TextField
          id="employee-email"
          name="email"
          label="Email"
          type="email"
          maxLength={254}
          defaultValue={initial?.email ?? ""}
          error={errors.email}
        />
        <TextField
          id="employee-phone"
          name="phone"
          label="Phone"
          maxLength={30}
          defaultValue={initial?.phone ?? ""}
          error={errors.phone}
        />
        <Field
          id="employee-login"
          label="Linked login"
          hint={
            logins.error
              ? "Logins couldn't be loaded; the current link is kept."
              : "Lets this person log their own time and expenses."
          }
          error={errors.userId}
        >
          {(control) => (
            <select
              {...control}
              name="userId"
              disabled={!logins.data}
              defaultValue={initial?.userId ?? ""}
              key={logins.data ? "loaded" : "loading"}
            >
              <option value="">
                {logins.data ? "No login" : "Loading logins…"}
              </option>
              {keepsOther ? (
                <option value={initial.userId!}>
                  Current login (not an employee account)
                </option>
              ) : null}
              {choices.map((user) => (
                <option key={user.userId} value={user.userId}>
                  {user.name} · {user.email}
                </option>
              ))}
            </select>
          )}
        </Field>
      </fieldset>
      <FormMessage message={message} />
      <div className="flex flex-wrap gap-3">
        <Button disabled={busy} type="submit">
          {busy ? "Saving…" : "Save employee"}
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
