"use client";
// anime.js effects for the landing page (#240). Each effect runs once (no
// looping, so WCAG 2.2.2 needs no pause control), never animates money, and
// jumps straight to its final state when reduced motion is requested.
import { animate, createTimeline, stagger } from "animejs";
import { useEffect, useRef, type ReactNode } from "react";

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Runs `play` once when the element first becomes 25% visible. `prepare`
 * sets the start state, but only for elements that begin below the fold,
 * so visible content never blinks out.
 */
function useOnceInView(
  play: (root: HTMLElement) => void,
  finish: (root: HTMLElement) => void,
  prepare?: (root: HTMLElement) => void,
) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    if (prefersReducedMotion()) {
      finish(root);
      return;
    }
    if (prepare && root.getBoundingClientRect().top >= window.innerHeight) {
      prepare(root);
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        play(root);
      },
      { threshold: 0.25 },
    );
    observer.observe(root);
    return () => observer.disconnect();
    // play/finish are module-level functions passed by the components below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return ref;
}

const all = (root: HTMLElement, selector: string) =>
  Array.from(root.querySelectorAll<HTMLElement | SVGElement>(selector));

function drawAll(root: HTMLElement) {
  for (const path of all(root, "[data-draw]")) {
    path.style.strokeDashoffset = "0";
  }
}

/**
 * Progress track for the hero's sample job. The coloured line starts
 * undrawn in the server HTML (pathLength=1, dashoffset 1); the step labels
 * already state each status, so the line is decoration only.
 */
export function JobTrack({ children }: { children: ReactNode }) {
  const ref = useOnceInView((root) => {
    createTimeline({ defaults: { ease: "outCubic" } })
      .add(all(root, "[data-draw]"), {
        strokeDashoffset: [1, 0],
        duration: 1600,
      })
      .add(
        all(root, "[data-step]"),
        { scale: [1, 1.25, 1], duration: 420, delay: stagger(380) },
        0,
      );
  }, drawAll);
  return <div ref={ref}>{children}</div>;
}

/** Workflow diagram: draws the connecting path, then pops each step in. */
export function FlowDiagram({ children }: { children: ReactNode }) {
  const ref = useOnceInView(
    (root) => {
      const steps = all(root, "[data-step]");
      createTimeline({ defaults: { ease: "outQuad" } })
        .add(all(root, "[data-draw]"), {
          strokeDashoffset: [1, 0],
          duration: 1800,
        })
        .add(
          steps,
          {
            opacity: [0, 1],
            translateY: [16, 0],
            duration: 500,
            delay: stagger(220),
          },
          0,
        );
    },
    drawAll,
    (root) => {
      for (const step of all(root, "[data-step]")) step.style.opacity = "0";
    },
  );
  return <div ref={ref}>{children}</div>;
}

/** Grows each `[data-bar]` segment from the left; widths are set in HTML. */
export function GrowBars({ children }: { children: ReactNode }) {
  const ref = useOnceInView(
    (root) => {
      void animate(all(root, "[data-bar]"), {
        scaleX: [0, 1],
        duration: 900,
        delay: stagger(250),
        ease: "outExpo",
      });
    },
    () => {},
    (root) => {
      for (const bar of all(root, "[data-bar]")) {
        bar.style.transform = "scaleX(0)";
      }
    },
  );
  return <div ref={ref}>{children}</div>;
}
