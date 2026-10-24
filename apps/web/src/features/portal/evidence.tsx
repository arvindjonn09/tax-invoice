"use client";
import { useState } from "react";
import { useRemote } from "@/components/data/use-remote";
import { useUnsavedChanges } from "@/components/form/use-unsaved-changes";
import { Field, FormMessage, sendJson } from "@/components/form/field";
import { Button } from "@/components/ui/button";
import { time } from "@/features/jobs/types";
type Item = {
  id: string;
  kind: string;
  note: string | null;
  documentId: string | null;
  createdAt: string;
};
export function EvidencePanel({
  jobId,
  status,
  refresh,
}: {
  jobId: string;
  status: string;
  refresh: () => void;
}) {
  const { data, error, reload } = useRemote<{
    evidence: Item[];
    reworkRequests?: { note: string; requestedAt: string }[];
  }>(`/api/my/work/${jobId}/evidence`);
  const [kind, setKind] = useState("note"),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false);
  const [uploaded, setUploaded] = useState<{
    id: string;
    fileName: string;
  } | null>(null);
  const [message, setMessage] = useState<{
    kind: "error" | "success";
    text: string;
  } | null>(null);
  const [links, setLinks] = useState<
    Record<string, { url: string; expiresAt: string }>
  >({});
  useUnsavedChanges(dirty);
  const canAdd = ["assigned", "in_progress", "awaiting_review"].includes(
    status,
  );
  return (
    <section className="min-w-0 space-y-4 rounded-lg border bg-card p-6 [overflow-wrap:anywhere]">
      <h2 className="text-xl font-semibold">My completion evidence</h2>
      <p className="text-sm text-muted-foreground">
        Only your own evidence is shown here. Files stay private; download links
        expire after five minutes.
      </p>
      {data?.reworkRequests?.length ? (
        <section
          aria-label="Rework instructions"
          className="space-y-3 rounded-lg border bg-muted p-4"
        >
          <h3 className="font-semibold">Rework requested by the office</h3>
          <ol className="space-y-3">
            {data.reworkRequests.map((request, index) => (
              <li key={`${request.requestedAt}:${index}`}>
                <p className="text-sm text-muted-foreground">
                  {time(request.requestedAt)}
                </p>
                <p className="whitespace-pre-wrap">{request.note}</p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <Button variant="outline" onClick={reload}>
            Retry evidence
          </Button>
        </div>
      ) : null}
      {!data && !error ? (
        <p role="status">Loading evidence…</p>
      ) : data ? (
        <ul className="space-y-3">
          {!data.evidence.length ? (
            <li>No evidence added yet.</li>
          ) : (
            data.evidence.map((item) => (
              <li key={item.id} className="space-y-2 rounded-lg border p-4">
                <h3 className="font-semibold">
                  {item.kind} · {time(item.createdAt)}
                </h3>
                {item.note ? (
                  <p className="whitespace-pre-wrap">{item.note}</p>
                ) : null}
                {item.documentId ? (
                  <>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        const result = await sendJson(
                          `/api/documents/${item.documentId}/link`,
                          "POST",
                          {},
                        );
                        setBusy(false);
                        if (!result.ok) {
                          setMessage({ kind: "error", text: result.message });
                          return;
                        }
                        const link = result.body as {
                          url: string;
                          expiresAt: string;
                        };
                        setLinks((previous) => ({
                          ...previous,
                          [item.id]: link,
                        }));
                      }}
                    >
                      Create download link
                    </Button>
                    {links[item.id] ? (
                      <p>
                        <a
                          className="inline-flex min-h-11 items-center underline"
                          href={links[item.id]!.url}
                        >
                          Download {item.kind}
                        </a>{" "}
                        · expires {time(links[item.id]!.expiresAt)}
                      </p>
                    ) : null}
                  </>
                ) : null}
              </li>
            ))
          )}
        </ul>
      ) : null}
      {canAdd ? (
        <form
          className="space-y-4 border-t pt-4"
          onChange={() => setDirty(true)}
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy) return;
            const element = e.currentTarget,
              form = new FormData(element);
            setMessage(null);
            setBusy(true);
            let document = uploaded;
            if (kind !== "note" && !document) {
              const file = form.get("file");
              if (!(file instanceof File) || !file.size) {
                setMessage({ kind: "error", text: "Choose an image." });
                setBusy(false);
                return;
              }
              if (file.size > 10 * 1024 * 1024) {
                setMessage({
                  kind: "error",
                  text: "Images can be at most 10 MB.",
                });
                setBusy(false);
                return;
              }
              const body = new FormData();
              body.set("file", file);
              body.set("kind", "photo");
              const response = await fetch("/api/documents", {
                method: "POST",
                body,
              }).catch(() => null);
              const json = (await response?.json().catch(() => null)) as {
                id?: string;
                fileName?: string;
                error?: string;
              } | null;
              if (!response?.ok || !json?.id) {
                setBusy(false);
                setMessage({
                  kind: "error",
                  text: json?.error ?? "Couldn't upload the image. Try again.",
                });
                return;
              }
              document = { id: json.id, fileName: json.fileName ?? file.name };
              setUploaded(document);
            }
            const note = String(form.get("note") ?? "").trim();
            if (kind === "note" && !note) {
              setBusy(false);
              setMessage({ kind: "error", text: "Write a work note." });
              return;
            }
            const result = await sendJson(
              `/api/my/work/${jobId}/evidence`,
              "POST",
              {
                kind,
                note: note || null,
                ...(kind === "note" ? {} : { documentId: document!.id }),
              },
            );
            setBusy(false);
            if (!result.ok) {
              setMessage({
                kind: "error",
                text: document
                  ? `${result.message} Your image is stored privately but is not yet attached. Retry to attach it without uploading again.`
                  : result.message,
              });
              return;
            }
            setDirty(false);
            setUploaded(null);
            setKind("note");
            element.reset();
            setMessage({
              kind: "success",
              text: "Evidence attached to this job.",
            });
            reload();
          }}
        >
          <fieldset className="space-y-4" disabled={busy}>
            <legend className="mb-3 font-semibold">Add evidence</legend>
            <Field id="evidence-kind" label="Evidence type">
              {(control) => (
                <select
                  {...control}
                  value={kind}
                  onChange={(e) => setKind(e.target.value)}
                >
                  <option value="note">Work note</option>
                  <option value="photo">Photo</option>
                  <option value="signature">Customer signature image</option>
                </select>
              )}
            </Field>
            {kind !== "note" ? (
              <Field
                id="evidence-file"
                label="Image *"
                hint="JPEG, PNG, WebP or HEIC, at most 10 MB. Upload a signature image only with the customer's consent."
              >
                {(control) => (
                  <input
                    {...control}
                    className={`${control.className} py-3`}
                    type="file"
                    name="file"
                    accept="image/jpeg,image/png,image/webp,image/heic,.heic"
                    required={!uploaded}
                    onChange={() => setUploaded(null)}
                  />
                )}
              </Field>
            ) : null}
            {uploaded ? (
              <p role="status">
                Private upload ready: {uploaded.fileName}. Save evidence to
                attach it.
              </p>
            ) : null}
            <Field
              id="evidence-note"
              label={kind === "note" ? "Work note *" : "Image description"}
            >
              {(control) => (
                <textarea
                  {...control}
                  className={`${control.className} min-h-28 py-3`}
                  name="note"
                  maxLength={2000}
                  required={kind === "note"}
                />
              )}
            </Field>
          </fieldset>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save evidence"}
          </Button>
        </form>
      ) : (
        <p>
          Evidence is read-only while the job is {status.replaceAll("_", " ")}.
        </p>
      )}
      <FormMessage message={message} />
      {status === "in_progress" ? (
        <Button
          disabled={busy || dirty}
          onClick={async () => {
            if (
              !window.confirm(
                "Submit this job for the office to review? Make sure your work evidence is saved.",
              )
            )
              return;
            setBusy(true);
            const result = await sendJson(
              `/api/my/work/${jobId}/submit`,
              "POST",
              {},
            );
            setBusy(false);
            if (!result.ok) setMessage({ kind: "error", text: result.message });
            else {
              setMessage({
                kind: "success",
                text: "Job submitted for review.",
              });
              refresh();
            }
          }}
        >
          Submit job for review
        </Button>
      ) : null}
    </section>
  );
}
