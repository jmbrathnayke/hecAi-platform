// Presentational bottom tab bar (UX mockups: citizen-home.html, officer-camera.html).
//
// Deliberately NOT generic over the Link component: the citizen tree routes through
// `@/navigation`'s locale-aware Link and the officer tree through `next/link`, and those two
// have incompatible `href` types. Rather than fight that with generics, this module exports the
// shell + the item styling and each tree composes its own links — see CitizenBottomNav.tsx and
// OfficerBottomNav.tsx.
import type { ReactNode } from "react";

/**
 * Sticky tab bar. The bottom padding is max(safe-area inset, 0.75rem) so the labels clear the
 * iOS home indicator, falling back to the mockups' ~12-16px when the inset is 0.
 *
 * (Written as one arbitrary value rather than spelled out in prose above, because Tailwind's
 * content scanner is plain text — a bare utility class quoted in a comment gets compiled into
 * a real, dead CSS rule.)
 */
export function BottomNav({ ariaLabel, children }: { ariaLabel: string; children: ReactNode }) {
  return (
    <nav
      aria-label={ariaLabel}
      data-testid="bottom-nav"
      className="sticky bottom-0 z-40 flex border-t border-border-default bg-surface-raised pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-design-2 print:hidden"
    >
      {children}
    </nav>
  );
}

/**
 * Item class for a tab link. `flex-1` divides the bar evenly (mockup) and `min-h-touch-target`
 * holds the 48px floor the rest of the app uses.
 */
export function bottomNavItemClass(active: boolean): string {
  return [
    "flex min-h-touch-target flex-1 flex-col items-center justify-center gap-design-1 px-design-1 py-design-1",
    active ? "text-forest" : "text-ink-disabled",
  ].join(" ");
}

/**
 * Item contents. `badge` renders the mockup's amber count pill (officer "Queue (5)"); it is
 * omitted entirely at 0/null so an empty queue shows no pill rather than a "0".
 */
export function BottomNavItemBody({
  icon,
  label,
  badge,
  active,
}: {
  icon: string;
  label: string;
  badge?: number | null;
  active: boolean;
}) {
  return (
    <>
      <span className="relative text-[22px] leading-none" aria-hidden="true">
        {icon}
        {badge != null && badge > 0 && (
          <span className="absolute -right-2 -top-1 min-w-[16px] rounded-pill bg-amber px-1 text-[10px] font-bold leading-[16px] text-ink-on-amber">
            {badge > 99 ? "99+" : badge}
          </span>
        )}
      </span>
      {/* text-center + leading-tight: Sinhala and Tamil tab labels are long enough to wrap to
          two lines at 360px across 3-4 tabs, and must stay legible rather than clip. */}
      <span
        className={`text-center text-[10px] leading-tight ${active ? "font-semibold" : "font-medium"}`}
      >
        {label}
      </span>
    </>
  );
}
