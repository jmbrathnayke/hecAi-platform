// Small presentational building blocks for the staff portals: the admin and DS desks and, with the
// touch sizes below, the officer field app (redesign, 2026-10-07).
//
// One shape scale everywhere in the admin area: panels are rounded-md (16px); controls, inputs,
// buttons and badges are rounded-sm (8px); avatars are rounded-pill. One accent: forest. Status
// colours appear only where they carry a case status. These primitives exist so every admin page
// gets that from one place instead of each page re-spelling a card.
import type { ReactNode } from "react";
import { STATUS_STYLES } from "@/components/admin/statusVocabulary";

/** Page title, an optional one-line summary under it, and actions on the right. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-design-3">
      <div className="min-w-0">
        <h1 className="text-display tracking-tight text-ink-primary [text-wrap:balance]">{title}</h1>
        {subtitle && <p className="mt-design-1 text-body text-ink-secondary">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-end gap-design-2">{actions}</div>}
    </header>
  );
}

/** A raised surface. Use only where the grouping is real; a heading is optional. */
export function Panel({
  title,
  aside,
  children,
  className = "",
  bodyClassName = "p-design-4",
  testId,
  as: Tag = "section",
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  testId?: string;
  as?: "section" | "div";
}) {
  return (
    <Tag
      className={`rounded-md border border-border-subtle bg-surface-raised shadow-card ${className}`}
      data-testid={testId}
    >
      {title && (
        <div className="flex items-center justify-between gap-design-3 border-b border-border-subtle px-design-4 py-design-3">
          <h2 className="text-label font-semibold text-ink-primary">{title}</h2>
          {aside}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </Tag>
  );
}

/** A case status as a small square-cornered badge. Never wraps. */
export function StatusBadge({ status, label }: { status: string; label: string }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-sm px-design-2 py-0.5 text-caption font-medium ${
        STATUS_STYLES[status] ?? "bg-surface-tint text-ink-secondary"
      }`}
    >
      {label}
    </span>
  );
}

/** A grey block standing in for content that is loading. Shaped by the caller. */
export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`block animate-pulse rounded-sm bg-surface-tint motion-reduce:animate-none ${className}`}
    />
  );
}

/** Shared button looks. Primary is the single forest accent; everything else is quieter. */
export const buttonStyles = {
  primary:
    "inline-flex min-h-[40px] items-center justify-center gap-design-2 rounded-sm bg-forest px-design-4 text-label font-semibold text-ink-on-dark transition-[background-color,transform] duration-150 hover:bg-forest-mid active:scale-[0.98] disabled:opacity-50 motion-reduce:transition-none",
  secondary:
    "inline-flex min-h-[40px] items-center justify-center gap-design-2 rounded-sm border border-border-subtle bg-surface-raised px-design-4 text-label font-medium text-ink-primary transition-[background-color,border-color,transform] duration-150 hover:border-border-default hover:bg-surface-base active:scale-[0.98] disabled:opacity-50 motion-reduce:transition-none",
  quiet:
    "inline-flex min-h-[40px] items-center justify-center gap-design-2 rounded-sm px-design-3 text-label font-medium text-ink-secondary transition-colors duration-150 hover:bg-surface-tint hover:text-ink-primary disabled:opacity-50 motion-reduce:transition-none",
  danger:
    "inline-flex min-h-[40px] items-center justify-center gap-design-2 rounded-sm border border-status-error bg-surface-raised px-design-4 text-label font-semibold text-status-error transition-[background-color,transform] duration-150 hover:bg-status-error-pale active:scale-[0.98] disabled:opacity-50 motion-reduce:transition-none",
} as const;

/** Field-app sizes (officer redesign, 2026-10-07). The officer works on a phone, outdoors, often
 *  one-handed, so these keep the app's 48px touch floor and the 56px primary button, where the
 *  desk portals above use 40px controls. Same shapes and the same single accent. */
export const touchButtonStyles = {
  primary:
    "inline-flex min-h-primary-btn w-full items-center justify-center gap-design-2 rounded-sm bg-forest px-design-5 text-headline font-semibold text-ink-on-dark transition-[background-color,transform] duration-150 hover:bg-forest-mid active:scale-[0.98] disabled:opacity-50 motion-reduce:transition-none",
  secondary:
    "inline-flex min-h-touch-target items-center justify-center gap-design-2 rounded-sm border border-border-subtle bg-surface-raised px-design-4 text-label font-semibold text-ink-primary transition-[background-color,border-color,transform] duration-150 hover:border-border-default hover:bg-surface-base active:scale-[0.98] disabled:opacity-50 motion-reduce:transition-none",
  quiet:
    "inline-flex min-h-touch-target items-center justify-center gap-design-2 rounded-sm px-design-3 text-label font-semibold text-forest transition-colors duration-150 hover:bg-surface-tint disabled:opacity-50 motion-reduce:transition-none",
} as const;

export const touchFieldStyles =
  "min-h-touch-target w-full rounded-sm border border-border-default bg-surface-raised px-design-3 text-body text-ink-primary transition-colors duration-150 placeholder:text-ink-secondary focus:border-forest focus:outline-none focus:ring-2 focus:ring-forest-pale motion-reduce:transition-none";

/** Inputs and selects in the admin area. */
export const fieldStyles =
  "min-h-[40px] w-full rounded-sm border border-border-subtle bg-surface-raised px-design-3 text-label text-ink-primary transition-colors duration-150 hover:border-border-default focus:border-forest focus:outline-none focus:ring-2 focus:ring-forest-pale motion-reduce:transition-none";
