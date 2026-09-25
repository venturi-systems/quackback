import type { ReactNode } from 'react'
import { MotionConfig, useReducedMotion } from 'framer-motion'

/**
 * Framer Motion animations follow the reader's reduced-motion preference, as
 * the app's CSS animations and transitions already do (globals.css): under
 * `prefers-reduced-motion: reduce`, every Framer Motion animation inside this
 * provider jumps to its end state instead of tweening.
 *
 * Framer Motion's own `reducedMotion="user"` is not enough here: it switches
 * off transform animations only, and the feedback composer's panels animate
 * their height. While that height tweened, content kept moving after keyboard
 * focus had been scrolled into view, so a focused control could end up below
 * the viewport (the render check's keyboard walk on the feed at 390px, runs
 * 36075134195 and 36089214718).
 */
export function ReducedMotionConfig({ children }: { children: ReactNode }) {
  // null until the browser has answered (the server render): animate as
  // before. Without reduced motion the prop is left out entirely, so an
  // enclosing MotionConfig's own setting still applies.
  const reduceMotion = useReducedMotion() === true
  return <MotionConfig {...(reduceMotion ? { skipAnimations: true } : {})}>{children}</MotionConfig>
}
