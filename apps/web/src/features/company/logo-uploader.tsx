"use client";
import { type ChangeEvent, useRef, useState } from "react";
import { useRemote } from "@/components/data/use-remote";
import { FormMessage } from "@/components/form/field";
import { Button } from "@/components/ui/button";

/** The server's limit (#227); checked here too, for a clearer message. */
const MAX_BYTES = 2 * 1024 * 1024;

type Message = { kind: "success" | "error"; text: string } | null;

/** The organisation's own logo: preview, upload or replace, and remove (S6). */
export function LogoUploader({
  hasLogo,
  editable,
  heading: Heading = "h3",
}: {
  hasLogo: boolean;
  editable: boolean;
  /** One level below the heading above it on the page. */
  heading?: "h2" | "h3";
}) {
  const input = useRef<HTMLInputElement>(null);
  const [present, setPresent] = useState(hasLogo);
  const [message, setMessage] = useState<Message>(null);
  const [pending, setPending] = useState(false);
  const { data, reload } = useRemote<{ url: string }>(
    present ? "/api/company/logo/link" : null,
  );

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setMessage({ kind: "error", text: "The file is larger than 2 MB" });
      return;
    }
    const form = new FormData();
    form.set("file", file);
    setPending(true);
    const response = await fetch("/api/company/logo", {
      method: "POST",
      body: form,
    }).catch(() => undefined);
    setPending(false);
    if (response?.ok) {
      setPresent(true);
      reload();
      setMessage({ kind: "success", text: "Logo saved." });
      return;
    }
    const body = (await response?.json().catch(() => null)) as {
      error?: string;
    } | null;
    setMessage({
      kind: "error",
      text: response
        ? (body?.error ?? "Couldn't save the logo. Try again.")
        : "Couldn't reach JobFlow. Check your connection and try again.",
    });
  }

  async function remove() {
    setPending(true);
    const response = await fetch("/api/company/logo", {
      method: "DELETE",
    }).catch(() => undefined);
    setPending(false);
    if (response?.ok) {
      setPresent(false);
      setMessage({ kind: "success", text: "Logo removed." });
    } else {
      setMessage({
        kind: "error",
        text: "Couldn't remove the logo. Try again.",
      });
    }
  }

  return (
    <div className="space-y-3">
      <Heading className="text-lg font-semibold">Logo</Heading>
      <p id="logo-hint" className="text-sm text-muted-foreground">
        Your own logo, for your quotes and invoices. PNG or JPEG, up to 2 MB and
        4000 × 4000 px.
      </p>
      <FormMessage message={message} />
      {present && data?.url ? (
        // A short-lived signed link to private storage, so not next/image.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={data.url}
          alt="Your logo"
          className="max-h-32 max-w-full rounded-sm border bg-white object-contain p-2"
        />
      ) : !present ? (
        <p className="text-muted-foreground">No logo yet.</p>
      ) : null}
      {editable ? (
        <div className="flex flex-wrap gap-3">
          <input
            ref={input}
            id="company-logo"
            type="file"
            accept="image/png,image/jpeg"
            aria-label="Logo file"
            aria-describedby="logo-hint"
            className="sr-only"
            tabIndex={-1}
            onChange={(event) => void upload(event)}
          />
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => input.current?.click()}
          >
            {pending ? "Saving…" : present ? "Replace logo" : "Upload logo"}
          </Button>
          {present ? (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => void remove()}
            >
              Remove logo
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
