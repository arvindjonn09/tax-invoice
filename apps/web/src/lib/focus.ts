"use client";
import { useEffect, useRef } from "react";

/**
 * A ref that moves focus to its element when `key` changes to something
 * truthy (and on mount, if it's truthy then). Unlike an inline
 * `ref={(node) => node?.focus()}`, it doesn't refocus on every render, so
 * typing elsewhere on the page keeps its focus.
 */
export function useFocusWhen<T extends HTMLElement>(key: unknown) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (key) ref.current?.focus();
  }, [key]);
  return ref;
}
