"use client";

// Damage-photo evidence for one case (backend migration 038).
//
// WHAT THIS REPLACES. Until now this component was a placeholder that explained why there were no
// photographs: none had ever reached the server. That explanation was honest about the gap but it
// left an administrator approving, and a Divisional Secretariat paying, on a class label and a
// percentage — a decision nobody downstream of the field officer could see the basis for. The
// photographs now upload, and this shows them.
//
// TWO SOURCES, KEPT APART ON PURPOSE. `citizen` is the household's own account of the damage;
// `officer` is what the field officer photographed at the site, which is the image MobileNetV2
// classified and therefore the one the assessment actually rests on. An approver reading a case
// file needs to know which they are looking at, so the label is part of the tile and not a legend
// somewhere else.
//
// URLS EXPIRE. The server hands out signed URLs valid for minutes against a private bucket. That
// is deliberate — a link that leaked would otherwise never expire — and it means this component
// must not cache them past the view. Nothing here writes to storage or keeps a copy.

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { listCasePhotos, type CasePhoto, type PhotoFailure } from "@/lib/casePhotos";

type Props = {
  /** Canonical id (HEC-2026-0295) or offline id. Absent -> the pre-upload explanation is kept,
   *  which is what the officer sees before a case reference exists. */
  caseRef?: string;
  /** `admin` reads a finished case file; `officer` is about to capture the assessment photo. */
  variant?: "admin" | "officer";
};

type State =
  | { kind: "loading" }
  | { kind: "ready"; photos: CasePhoto[] }
  | { kind: "failed"; failure: PhotoFailure };

export function PhotoGallery({ caseRef, variant = "admin" }: Props) {
  const t = useTranslations("admin");
  const [state, setState] = useState<State>({ kind: "loading" });
  // Which tile is open full-size. Kept here rather than in a route so the approver never loses
  // their place in the case file to look at a photograph.
  const [expanded, setExpanded] = useState<CasePhoto | null>(null);

  const load = useCallback(async () => {
    if (!caseRef) return;
    setState({ kind: "loading" });
    const res = await listCasePhotos(caseRef);
    setState(res.ok ? { kind: "ready", photos: res.photos } : { kind: "failed", failure: res.failure });
  }, [caseRef]);

  useEffect(() => {
    void load();
  }, [load]);

  // Without a case reference there is nothing to fetch. That is the officer's state before they
  // open a case, and the explanation is still the right thing to show.
  if (!caseRef) {
    return (
      <div
        className="rounded-md border border-dashed border-border-default p-design-4 text-caption text-ink-secondary"
        data-testid={`photo-notice-${variant}`}
      >
        {t(variant === "officer" ? "photo.officerNotice" : "photo.adminNotice")}
      </div>
    );
  }

  if (state.kind === "loading") {
    return (
      <p role="status" className="text-caption text-ink-secondary" data-testid="photo-loading">
        {t("photo.loading")}
      </p>
    );
  }

  if (state.kind === "failed") {
    return (
      <div
        className="rounded-md border border-dashed border-border-default p-design-4 text-caption text-ink-secondary"
        data-testid="photo-error"
      >
        <p>
          {t(
            state.failure.reason === "storage-not-configured"
              ? "photo.storageUnavailable"
              : "photo.loadFailed",
          )}
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-design-2 min-h-touch-target text-label font-semibold text-forest underline"
        >
          {t("photo.retry")}
        </button>
      </div>
    );
  }

  if (state.photos.length === 0) {
    return (
      <div
        className="rounded-md border border-dashed border-border-default p-design-4 text-caption text-ink-secondary"
        data-testid="photo-empty"
      >
        {t("photo.none")}
      </div>
    );
  }

  return (
    <div data-testid="photo-gallery">
      <ul className="grid grid-cols-2 gap-design-3 sm:grid-cols-3">
        {state.photos.map((photo) => (
          <li key={photo.id} className="space-y-design-1">
            {photo.url ? (
              <button
                type="button"
                onClick={() => setExpanded(photo)}
                className="block w-full overflow-hidden rounded-md border border-border-subtle"
                aria-label={t(`photo.expand.${photo.source}`)}
              >
                {/* unoptimized: the src is a short-lived signed URL against a private bucket.
                    Routing it through the Next image optimizer would both fail (the optimizer
                    fetches server-side, without the caller's session) and cache a credential. */}
                <Image
                  src={photo.url}
                  alt={t(`photo.alt.${photo.source}`)}
                  width={320}
                  height={240}
                  unoptimized
                  className="h-32 w-full object-cover"
                />
              </button>
            ) : (
              <div
                data-testid="photo-unavailable"
                className="flex h-32 w-full items-center justify-center rounded-md border border-dashed border-border-default p-design-2 text-center text-caption text-ink-disabled"
              >
                {t("photo.unavailable")}
              </div>
            )}
            <p className="text-caption text-ink-secondary" data-testid={`photo-source-${photo.source}`}>
              {t(`photo.source.${photo.source}`)}
            </p>
          </li>
        ))}
      </ul>

      {/* The officer's photograph is the model input; the citizen's is not. Said once under the
          grid rather than on every tile, so the distinction is available without shouting. */}
      <p className="mt-design-3 text-caption text-ink-secondary">{t("photo.sourceNote")}</p>

      {expanded?.url && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t(`photo.alt.${expanded.source}`)}
          data-testid="photo-lightbox"
          onClick={() => setExpanded(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-design-4"
        >
          <Image
            src={expanded.url}
            alt={t(`photo.alt.${expanded.source}`)}
            width={1280}
            height={960}
            unoptimized
            className="max-h-full w-auto max-w-full object-contain"
          />
          <button
            type="button"
            onClick={() => setExpanded(null)}
            className="absolute right-design-4 top-design-4 min-h-touch-target rounded-md bg-surface-raised px-design-3 text-label font-semibold text-ink-primary"
          >
            {t("photo.close")}
          </button>
        </div>
      )}
    </div>
  );
}
