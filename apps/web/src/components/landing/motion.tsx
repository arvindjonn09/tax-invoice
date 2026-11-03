"use client";
// Landing-page motion helpers (#240). Content is server-rendered visible; we
// only hide what starts below the fold, after hydration, so nothing is lost
// when JavaScript fails and nothing above the fold flickers.
import { animate, inView } from "motion";
import {
  MotionConfig,
  motion,
  useReducedMotion,
  useScroll,
  useSpring,
} from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";

const EASE = [0.22, 1, 0.36, 1] as const;

export function LandingMotion({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}

/** Thin decorative bar showing how far down the page the reader is. */
export function ScrollProgress() {
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, { stiffness: 120, damping: 30 });
  return (
    <motion.div
      aria-hidden="true"
      className="fixed inset-x-0 top-0 z-20 h-1 origin-left bg-primary"
      style={{ scaleX }}
    />
  );
}

/** Fades and lifts its children in the first time they scroll into view. */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    const element = ref.current;
    if (!element || reduce) return;
    if (element.getBoundingClientRect().top < window.innerHeight) return;
    element.style.opacity = "0";
    element.style.transform = "translateY(24px)";
    return inView(
      element,
      () => {
        void animate(
          element,
          { opacity: 1, transform: "translateY(0px)" },
          { duration: 0.6, delay, ease: EASE },
        );
      },
      { amount: 0.15 },
    );
  }, [delay, reduce]);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

/** Card that lifts slightly on hover or keyboard focus within. */
export function LiftCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.article
      className={className}
      whileHover={{ y: -4 }}
      whileFocus={{ y: -4 }}
      transition={{ duration: 0.18, ease: EASE }}
    >
      {children}
    </motion.article>
  );
}
