"use client";

// Damage-photo section (Story 5.4, AC1). Placeholder-only by PO decision (2026-07-13): no
// photo-upload pipeline exists anywhere in the backend today — photos are captured into the
// submitting device's own IndexedDB `photo_blobs` store (lib/indexeddb.ts) and never reach
// the server on any path (verified against buildCasePayload in lib/poc.ts and the as-built
// endpoint list in architecture.md). Kept as its own component, not inlined, so a future
// photo-upload story has a single obvious seam to replace — see
// _bmad-output/implementation-artifacts/deferred-work.md for that story's scope.
//
// WHY THIS NOW EXPLAINS ITSELF INSTEAD OF SAYING "not available yet". The previous copy read as an
// unfinished feature, so a reader concluded something was broken — which is exactly what happened
// when the officer screen showed nothing at all and the assessor assumed the citizen's photos had
// been lost. They were not: they are on the citizen's phone, deliberately, and the officer
// photographs the damage in front of them. That is a defensible design with two real reasons
// (a rural connection should not have to carry image uploads, and the assessed evidence should be
// what the assessor saw), and stating them turns a blank panel into a legible decision.
//
// `variant` only changes the wording, never the behaviour: an administrator is reading a case file
// after the fact, an officer is standing in the field about to photograph it themselves.
import { useTranslations } from "next-intl";

type Props = {
  /** `admin` reads a finished case file; `officer` is about to capture the assessment photo. */
  variant?: "admin" | "officer";
};

export function PhotoGallery({ variant = "admin" }: Props) {
  const t = useTranslations("admin");
  const key = variant === "officer" ? "photo.officerNotice" : "photo.adminNotice";

  return (
    <div
      className="rounded-md border border-dashed border-border-default p-design-4 text-caption text-ink-secondary"
      data-testid={`photo-notice-${variant}`}
    >
      {t(key)}
    </div>
  );
}
