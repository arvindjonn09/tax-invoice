"use client";
import { type FormEvent, useEffect, useState } from "react";
import { type Role, ROLES } from "@jobflow/authz";
import { Button } from "@/components/ui/button";
import { ROLE_LABELS } from "@/server/shell";

const control =
  "min-h-11 w-full min-w-0 rounded-sm border border-input bg-card px-4 text-card-foreground";
type Member = {
  id: string;
  userId: string;
  role: Role;
  isActive: boolean;
  user: { name: string | null; email: string };
};
type Invitation = { id: string; email: string; role: Role; expiresAt: string };
type Directory = {
  members: Member[];
  invitations: Invitation[];
  total: number;
  pageSize: number;
  page: number;
};

export function UserAccess() {
  const [data, setData] = useState<Directory>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/users?q=${encodeURIComponent(query)}&page=${page}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error("Unable to load user access. Try again.");
        return response.json() as Promise<Directory>;
      })
      .then((result) => {
        setData(result);
        setError("");
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error ? reason.message : "Unable to load users.",
          );
      });
    return () => controller.abort();
  }, [query, page, revision]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function mutate(path: string, method: string, body?: unknown) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = (await response.json()) as {
        error?: string;
        invitationPath?: string;
        fields?: Record<string, string>;
      };
      if (!response.ok)
        throw new Error(
          result.fields
            ? Object.values(result.fields).join(". ")
            : (result.error ?? "Unable to save. Try again."),
        );
      setDirty(false);
      setNotice("Access changes saved.");
      setRevision((value) => value + 1);
      return result;
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to save. Try again.",
      );
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    setLink("");
    const result = await mutate("/api/users/invitations", "POST", {
      email: fields.get("email"),
      role: fields.get("role"),
    });
    if (result?.invitationPath) {
      setLink(new URL(result.invitationPath, window.location.origin).href);
      setNotice(
        "Invitation created. Copy the link and share it privately with the invited person.",
      );
      form.reset();
    }
  }
  async function changeRole(event: FormEvent<HTMLFormElement>, member: Member) {
    event.preventDefault();
    const role = new FormData(event.currentTarget).get("role");
    if (
      role === member.role ||
      !window.confirm(
        `Change ${member.user.name ?? member.user.email} to ${ROLE_LABELS[role as Role]}? Their permissions change immediately.`,
      )
    )
      return;
    await mutate(`/api/users/${member.id}`, "PATCH", { role });
  }
  return (
    <div className="space-y-6" aria-busy={busy}>
      {error ? (
        <div
          role="alert"
          className="rounded-lg bg-danger p-4 text-danger-foreground"
        >
          <p>{error}</p>
          <Button
            variant="outline"
            onClick={() => setRevision((value) => value + 1)}
          >
            Reload user access
          </Button>
        </div>
      ) : null}
      <p role="status">{notice}</p>
      <section
        className="space-y-4 rounded-lg border bg-card p-6 text-card-foreground"
        aria-labelledby="invite-heading"
      >
        <h2 id="invite-heading" className="text-xl font-semibold">
          Invite a team member
        </h2>
        <p>
          Invitations expire after 48 hours and work once. Share the link
          privately; email delivery is not configured.
        </p>
        <form
          onSubmit={invite}
          onChange={() => setDirty(true)}
          className="grid gap-4 md:grid-cols-2"
        >
          <label className="space-y-2">
            Email (required)
            <input
              className={control}
              name="email"
              type="email"
              autoComplete="email"
              maxLength={320}
              required
            />
          </label>
          <label className="space-y-2">
            Invitation role
            <select className={control} name="role" defaultValue="employee">
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role]}
                </option>
              ))}
            </select>
          </label>
          <Button disabled={busy} type="submit">
            {busy ? "Saving…" : "Create invitation"}
          </Button>
        </form>
        {link ? (
          <label className="block space-y-2">
            Invitation link — shown only now
            <input
              className={control}
              value={link}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
            />
            <span className="block text-sm">
              Copy this link before leaving. Revoke the invitation if it reaches
              the wrong person.
            </span>
          </label>
        ) : null}
      </section>
      <section className="space-y-4" aria-labelledby="members-heading">
        <h2 id="members-heading" className="text-xl font-semibold">
          Company members
        </h2>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setData(undefined);
            setQuery(String(new FormData(event.currentTarget).get("q") ?? ""));
            setRevision((value) => value + 1);
          }}
        >
          <label className="min-w-0 flex-1 space-y-2">
            Search names or emails
            <input className={control} name="q" maxLength={100} type="search" />
          </label>
          <Button type="submit" disabled={busy}>
            Search
          </Button>
        </form>
        {!data && !error ? <p role="status">Loading company members…</p> : null}
        {data?.members.length === 0 ? (
          <p>No members match this search. Try another name or email.</p>
        ) : null}
        <ul className="grid gap-4 lg:grid-cols-2">
          {data?.members.map((member) => (
            <li
              key={`${member.id}-${member.role}-${member.isActive}`}
              className="min-w-0 space-y-4 rounded-lg border bg-card p-6 text-card-foreground"
            >
              <h3 className="break-words font-semibold">
                {member.user.name ?? member.user.email}
              </h3>
              <p className="break-all text-sm">{member.user.email}</p>
              <p>
                {member.isActive ? "Active" : "Inactive"} ·{" "}
                {ROLE_LABELS[member.role]}
              </p>
              <form
                onSubmit={(event) => void changeRole(event, member)}
                onChange={() => setDirty(true)}
                className="flex flex-wrap items-end gap-2"
              >
                <label className="min-w-0 flex-1 space-y-2">
                  Role for {member.user.name ?? member.user.email}
                  <select
                    className={control}
                    name="role"
                    defaultValue={member.role}
                    disabled={busy}
                  >
                    {ROLES.map((role) => (
                      <option key={role} value={role}>
                        {ROLE_LABELS[role]}
                      </option>
                    ))}
                  </select>
                </label>
                <Button type="submit" disabled={busy} variant="outline">
                  Save role
                </Button>
              </form>
              <Button
                disabled={busy}
                variant={member.isActive ? "destructive" : "outline"}
                onClick={() => {
                  if (
                    window.confirm(
                      `${member.isActive ? "Deactivate" : "Restore"} access for ${member.user.name ?? member.user.email}? ${member.isActive ? "Their company access ends immediately." : "They can access this company again."}`,
                    )
                  )
                    void mutate(`/api/users/${member.id}`, "PATCH", {
                      isActive: !member.isActive,
                    });
                }}
              >
                {member.isActive ? "Deactivate access" : "Restore access"}
              </Button>
            </li>
          ))}
        </ul>
        {data ? (
          <nav
            aria-label="Member pages"
            className="flex flex-wrap items-center gap-4"
          >
            <Button
              variant="outline"
              disabled={busy || page <= 1}
              onClick={() => {
                setData(undefined);
                setPage((value) => value - 1);
              }}
            >
              Previous
            </Button>
            <span>
              Page {data.page} of{" "}
              {Math.max(1, Math.ceil(data.total / data.pageSize))} ·{" "}
              {data.total} members
            </span>
            <Button
              variant="outline"
              disabled={busy || page * data.pageSize >= data.total}
              onClick={() => {
                setData(undefined);
                setPage((value) => value + 1);
              }}
            >
              Next
            </Button>
          </nav>
        ) : null}
      </section>
      <section className="space-y-4" aria-labelledby="pending-heading">
        <h2 id="pending-heading" className="text-xl font-semibold">
          Pending invitations
        </h2>
        {data?.invitations.length === 0 ? <p>No pending invitations.</p> : null}
        <ul className="space-y-4">
          {data?.invitations.map((invitation) => (
            <li
              key={invitation.id}
              className="flex flex-wrap items-center justify-between gap-4 rounded-lg border bg-card p-4 text-card-foreground"
            >
              <div className="min-w-0">
                <p className="break-all">
                  {invitation.email} · {ROLE_LABELS[invitation.role]}
                </p>
                <p className="text-sm">
                  Expires{" "}
                  {new Date(invitation.expiresAt).toLocaleString("en-AU", {
                    timeZone: "Australia/Sydney",
                  })}{" "}
                  (Sydney)
                </p>
              </div>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      `Revoke the invitation for ${invitation.email}?`,
                    )
                  ) {
                    setLink("");
                    void mutate(
                      `/api/users/invitations/${invitation.id}`,
                      "DELETE",
                    );
                  }
                }}
              >
                Revoke invitation
              </Button>
            </li>
          ))}
        </ul>
        {data && data.invitations.length >= 100 ? (
          <p>Showing the most recent 100 pending invitations.</p>
        ) : null}
      </section>
    </div>
  );
}
