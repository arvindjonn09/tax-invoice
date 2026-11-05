"use client";
import { useEffect, useRef } from "react";

const SCRIPT =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type TurnstileApi = {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ): string;
  remove(id: string): void;
};

function loadApi(): Promise<TurnstileApi> {
  const holder = window as unknown as { turnstile?: TurnstileApi };
  if (holder.turnstile) return Promise.resolve(holder.turnstile);
  return new Promise((resolve, reject) => {
    let script = document.querySelector<HTMLScriptElement>(
      `script[src="${SCRIPT}"]`,
    );
    if (!script) {
      // Added by a trusted bundle, so CSP 'strict-dynamic' allows it.
      script = document.createElement("script");
      script.src = SCRIPT;
      script.async = true;
      document.head.append(script);
    }
    script.addEventListener("load", () =>
      holder.turnstile ? resolve(holder.turnstile) : reject(new Error("load")),
    );
    script.addEventListener("error", () => reject(new Error("load")));
  });
}

/**
 * Cloudflare Turnstile challenge (S2 AC8). Tokens are single use, so remount
 * with a new `key` after a failed submit. Reports null when none is valid.
 */
export function Turnstile({
  siteKey,
  action,
  onToken,
}: {
  siteKey: string;
  action: string;
  onToken: (token: string | null) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const callback = useRef(onToken);
  useEffect(() => {
    callback.current = onToken;
  });
  useEffect(() => {
    let widget: string | undefined;
    let api: TurnstileApi | undefined;
    let cancelled = false;
    void loadApi()
      .then((loaded) => {
        if (cancelled || !container.current) return;
        api = loaded;
        widget = loaded.render(container.current, {
          sitekey: siteKey,
          action,
          callback: (token) => callback.current(token),
          "expired-callback": () => callback.current(null),
          "error-callback": () => callback.current(null),
        });
      })
      .catch(() => callback.current(null));
    return () => {
      cancelled = true;
      if (api && widget) api.remove(widget);
    };
  }, [siteKey, action]);
  return <div ref={container} data-testid="turnstile" />;
}
