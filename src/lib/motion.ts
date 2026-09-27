import type { Transition, Variants } from 'motion/react';

/**
 * Shared motion presets for the VisLex Modern design language.
 *
 * Surfaces should compose these instead of hand-rolling transitions so the
 * whole app shares one physical feel. Anything animated must also degrade
 * under prefers-reduced-motion: pair these with `useReducedMotion()` from
 * motion/react (or the CSS guards in styles.css) and swap to opacity-only
 * or no-op variants.
 */

export const springs = {
  /** Large surfaces: sidebar collapse, pane resize. */
  gentle: { type: 'spring', stiffness: 220, damping: 28 },
  /** Small controls: buttons, chips, tabs. */
  snappy: { type: 'spring', stiffness: 420, damping: 32 },
  /** Modals, popovers, palette. */
  overlay: { type: 'spring', stiffness: 340, damping: 30 },
} satisfies Record<string, Transition>;

export const ease = {
  out: [0.22, 1, 0.36, 1] as const,
  inOut: [0.65, 0, 0.35, 1] as const,
};

/** View/panel entrance: subtle rise + fade. */
export const fadeRise: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.18, ease: ease.out } },
};

/** Staggered container for list rows; children use `fadeRise`. */
export const staggerContainer: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.02 } },
};

/** Opacity-only fallback for reduced-motion contexts. */
export const fadeOnly: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.1 } },
};

/** Overlay/dialog entrance used with `springs.overlay`. */
export const overlayIn: Variants = {
  hidden: { opacity: 0, scale: 0.97, y: 6 },
  visible: { opacity: 1, scale: 1, y: 0, transition: springs.overlay },
  exit: { opacity: 0, scale: 0.98, transition: { duration: 0.12 } },
};
