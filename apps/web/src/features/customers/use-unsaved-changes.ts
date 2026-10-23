"use client";
import { useEffect } from "react";

type NavigateEvent = Event & { navigationType: string; canIntercept: boolean };

/** Guard document exits, links and same-document history traversal. */
export function useUnsavedChanges(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const confirm = () => window.confirm("Discard unsaved changes?");
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    const link = (event: MouseEvent) => {
      if ((event.target as Element).closest?.("a[href]") && !confirm()) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    // The Navigation API cancels traversal before the router unmounts the form.
    const navigation = (window as Window & { navigation?: EventTarget })
      .navigation;
    const traverse = (event: Event) => {
      const next = event as NavigateEvent;
      if (next.navigationType === "traverse" && next.canIntercept && !confirm())
        event.preventDefault();
    };
    // Older browsers lack cancellable navigation. Capture popstate ahead of the
    // router and restore the current entry when the owner keeps their edits.
    const currentUrl = window.location.href;
    const currentState: unknown = window.history.state;
    const restore = (event: PopStateEvent) => {
      if (!confirm()) {
        event.stopImmediatePropagation();
        window.history.pushState(currentState, "", currentUrl);
      }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", link, true);
    if (navigation) navigation.addEventListener("navigate", traverse);
    else window.addEventListener("popstate", restore, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", link, true);
      if (navigation) navigation.removeEventListener("navigate", traverse);
      else window.removeEventListener("popstate", restore, true);
    };
  }, [dirty]);
}
