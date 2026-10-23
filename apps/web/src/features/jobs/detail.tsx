"use client";
import Link from "next/link";
import { useState } from "react";
import { isJobEditable } from "@jobflow/domain";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { MoneyDisplay } from "@/components/money-display";
import { FormMessage } from "@/components/form/field";
import { hasUnsavedChanges } from "@/components/form/use-unsaved-changes";
import { useRemote } from "@/components/data/use-remote";
import { JobEditor } from "./editor";
import { AssignmentsPanel, StatusForm, VisitsPanel } from "./actions";
import { day, time, statusLabel, type Job } from "./types";
export function JobDetail({
  id,
  office,
  editable,
}: {
  id: string;
  office: boolean;
  editable: boolean;
}) {
  const { data, error, reload } = useRemote<Job>(
    `${office ? "/api/jobs" : "/api/my/jobs"}/${id}`,
  );
  const [tab, setTab] = useState("overview");
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<{
    kind: "success";
    text: string;
  } | null>(null);
  const tabs = office
    ? ["overview", "assignments", "visits", "files", "timeline"]
    : ["overview", "visits", "files"];
  if (!data)
    return error ? (
      <>
        <PageHeader title="Job" />
        <div role="alert">
          <p>{error}</p>
          <Button onClick={reload}>Try again</Button>
        </div>
      </>
    ) : (
      <p role="status">Loading job…</p>
    );
  const canEdit = editable && isJobEditable(data.status);
  const choose = (value: string) => {
    if (value === tab) return;
    if (
      hasUnsavedChanges() &&
      !window.confirm("Discard unsaved changes before switching sections?")
    )
      return;
    setEditing(false);
    setTab(value);
  };
  return (
    <>
      <PageHeader
        title={`${data.reference} · ${data.title}`}
        description={statusLabel(data.status)}
        breadcrumbs={[
          { label: office ? "Jobs" : "My jobs", href: "/jobs" },
          { label: data.reference },
        ]}
      />
      <FormMessage message={message} />
      {error ? (
        <div role="alert" className="space-y-3 rounded-lg border bg-card p-4">
          <p>{error} Showing the last loaded details.</p>
          <Button variant="outline" onClick={reload}>
            Try again
          </Button>
        </div>
      ) : null}
      <div
        role="tablist"
        aria-label="Job sections"
        className="flex flex-wrap gap-2"
        onKeyDown={(event) => {
          const index = tabs.indexOf(
            (event.target as HTMLElement).getAttribute("data-tab") ?? "",
          );
          if (index < 0) return;
          const next =
            event.key === "ArrowRight"
              ? (index + 1) % tabs.length
              : event.key === "ArrowLeft"
                ? (index + tabs.length - 1) % tabs.length
                : event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? tabs.length - 1
                    : null;
          if (next !== null) {
            event.preventDefault();
            document.getElementById(`job-tab-${tabs[next]}`)?.focus();
          }
        }}
      >
        {tabs.map((value) => (
          <button
            key={value}
            type="button"
            id={`job-tab-${value}`}
            data-tab={value}
            role="tab"
            aria-selected={tab === value}
            aria-controls={`job-panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            className={`min-h-11 rounded-sm border px-4 py-2 font-medium ${tab === value ? "border-primary bg-primary text-primary-foreground" : "bg-card text-card-foreground"}`}
            onClick={() => choose(value)}
          >
            {statusLabel(value)}
          </button>
        ))}
      </div>
      {tabs.map((value) => (
        <section
          key={value}
          role="tabpanel"
          id={`job-panel-${value}`}
          aria-labelledby={`job-tab-${value}`}
          hidden={tab !== value}
          tabIndex={0}
          className="min-w-0 space-y-6 rounded-lg border bg-card p-6 [overflow-wrap:anywhere]"
        >
          {tab !== value ? null : value === "overview" ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-xl font-semibold">Overview</h2>
                {canEdit && !editing ? (
                  <Button variant="outline" onClick={() => setEditing(true)}>
                    Edit job
                  </Button>
                ) : null}
              </div>
              {editing ? (
                <JobEditor
                  initial={data}
                  onCancel={() => setEditing(false)}
                  onSaved={() => {
                    setEditing(false);
                    setMessage({ kind: "success", text: "Job saved." });
                    reload();
                  }}
                />
              ) : (
                <>
                  <dl className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <dt className="text-sm text-muted-foreground">Status</dt>
                      <dd>{statusLabel(data.status)}</dd>
                    </div>
                    <div>
                      <dt className="text-sm text-muted-foreground">
                        Due date
                      </dt>
                      <dd>{day(data.dueOn)}</dd>
                    </div>
                    {office ? (
                      <div>
                        <dt className="text-sm text-muted-foreground">
                          Agreed price
                        </dt>
                        <dd>
                          {data.agreedPriceExclusiveCents == null ? (
                            "Not provided"
                          ) : (
                            <MoneyDisplay
                              cents={BigInt(data.agreedPriceExclusiveCents)}
                              basis="ex GST"
                            />
                          )}
                        </dd>
                      </div>
                    ) : null}
                    <div className="sm:col-span-2">
                      <dt className="text-sm text-muted-foreground">
                        Work description
                      </dt>
                      <dd className="whitespace-pre-wrap break-words">
                        {data.description || "Not provided"}
                      </dd>
                    </div>
                  </dl>
                  {office && data.customerId ? (
                    <OfficeCustomer
                      customerId={data.customerId}
                      locationId={data.locationId}
                    />
                  ) : (
                    <div className="space-y-3">
                      <h3 className="font-semibold">Customer and site</h3>
                      <p>{data.customerName}</p>
                      <SiteDetails site={data.site} />
                    </div>
                  )}
                  {editable ? (
                    <section
                      aria-label="Change job status"
                      className="space-y-4 border-t pt-6"
                    >
                      <h3 className="text-lg font-semibold">Change status</h3>
                      <StatusForm
                        key={data.status}
                        job={data}
                        saved={() => {
                          setMessage({
                            kind: "success",
                            text: "Status updated.",
                          });
                          reload();
                        }}
                      />
                    </section>
                  ) : null}
                </>
              )}
            </>
          ) : value === "visits" ? (
            <VisitsPanel job={data} editable={canEdit} saved={reload} />
          ) : value === "assignments" ? (
            <AssignmentsPanel job={data} editable={canEdit} saved={reload} />
          ) : value === "files" ? (
            <>
              <h2 className="text-xl font-semibold">Files</h2>
              <p className="text-muted-foreground">
                Job files and completion evidence are coming in a later release.
              </p>
            </>
          ) : (
            <>
              <h2 className="text-xl font-semibold">Status timeline</h2>
              <ol className="space-y-4">
                {data.statusHistory?.map((event) => (
                  <li
                    key={event.id}
                    className="space-y-1 border-l-2 border-primary pl-4"
                  >
                    <p className="font-medium">
                      {event.fromStatus
                        ? `${statusLabel(event.fromStatus)} → `
                        : "Created as "}
                      {statusLabel(event.toStatus)}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {time(event.createdAt)} · {event.actorName}
                    </p>
                    {event.note ? (
                      <p className="whitespace-pre-wrap break-words">
                        {event.note}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      ))}
      <Link
        className="inline-flex min-h-11 items-center underline"
        href="/jobs"
      >
        Back to jobs
      </Link>
    </>
  );
}
type Site = NonNullable<Job["site"]>;
function SiteDetails({ site }: { site: Site | null | undefined }) {
  return site ? (
    <div className="space-y-2">
      <p>
        {[
          site.label,
          site.addressLine1,
          site.addressLine2,
          site.suburb,
          site.state,
          site.postcode,
        ]
          .filter(Boolean)
          .join(", ")}
      </p>
      {site.accessNotes ? (
        <p className="whitespace-pre-wrap">Access: {site.accessNotes}</p>
      ) : null}
    </div>
  ) : (
    <p className="text-muted-foreground">No site selected.</p>
  );
}
function OfficeCustomer({
  customerId,
  locationId,
}: {
  customerId: string;
  locationId: string | null | undefined;
}) {
  const { data, error, reload } = useRemote<{
    name: string;
    locations: (Site & { id: string })[];
  }>(`/api/customers/${customerId}`);
  return (
    <section className="space-y-3">
      <h3 className="font-semibold">Customer and site</h3>
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <Button variant="outline" onClick={reload}>
            Retry customer
          </Button>
        </div>
      ) : !data ? (
        <p role="status">Loading customer…</p>
      ) : (
        <>
          <Link
            className="inline-flex min-h-11 items-center underline"
            href={`/customers/${customerId}`}
          >
            {data.name}
          </Link>
          <SiteDetails
            site={data.locations.find((site) => site.id === locationId)}
          />
        </>
      )}
    </section>
  );
}
