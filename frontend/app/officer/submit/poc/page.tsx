"use client";

// Officer PoC receipt (Story 3.5, AC6). Renders the citizen's Proof of Claim after an
// officer-assisted submission: reuses the existing PoCCard (QR of the offline_id via
// qrcode.react + reference + timestamp) and composes an officer-ID badge and the citizen
// NIC masked to its last 4 chars around it. Localized si/ta/en (Story 6.2, FR-9.1) via the
// officer i18n provider added in Story 6.1 — PoCCard now inherits the officer layout's locale,
// so the previous local English-only NextIntlClientProvider wrapper was removed.
//
// Offline-first (CRITICAL #3): the receipt is built from the persisted draft and shown
// immediately; a best-effort online submit only upgrades the reference to the canonical id.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { PoCCard } from "@/components/PoCCard";
import { getCase, updateDraft } from "@/lib/indexeddb";
import { getDraftId, clearDraftId } from "@/lib/draft";
import { buildCasePayload, buildPoC, submitCaseOnline, type PoCRecord } from "@/lib/poc";
import { enqueueCase } from "@/lib/syncQueue";
import { createClient } from "@/lib/supabase";
import { OFFICER_POC_NIC_KEY, clearOfficerPocMask } from "@/lib/officerPoc";

export default function OfficerPoCPage() {
  const t = useTranslations("officer");
  const router = useRouter();
  const [poc, setPoc] = useState<PoCRecord | null>(null);
  const [canonicalId, setCanonicalId] = useState<string | null>(null);
  const [officerId, setOfficerId] = useState<string | null>(null);
  const [nicLast4, setNicLast4] = useState<string | null>(null);
  // Known synchronously from mount (unlike `poc`, which is only set after the async
  // getCase/buildPoC chain resolves) — lets the sync-event listener below match a case
  // even if the event fires before `poc` is ready (review patch: closes that race).
  const draftIdRef = useRef<string | null>(null);

  useEffect(() => {
    const draftId = getDraftId();
    draftIdRef.current = draftId;
    if (!draftId) {
      router.replace("/officer/submit");
      return;
    }

    // In-session mask (last 4 of the citizen NIC) — never persisted to IndexedDB / the server.
    try {
      const stored = sessionStorage.getItem(OFFICER_POC_NIC_KEY);
      if (stored) setNicLast4(stored);
    } catch {
      /* storage blocked — omit the mask */
    }

    let active = true;
    (async () => {
      const draft = await getCase(draftId);
      if (!active || !draft) {
        if (active) router.replace("/officer/submit");
        return;
      }
      const record = await buildPoC(draft);
      if (!active) return;
      setPoc(record);
      setOfficerId(typeof draft.officer_id === "string" ? draft.officer_id : null);
      // Functional update: don't clobber a canonical id the hec-case-synced listener may
      // already have set from a sync that completed while this async chain was in flight
      // (review patch) — the draft read here can be stale relative to that live event.
      setCanonicalId((prev) => prev ?? (typeof draft.canonical_id === "string" ? draft.canonical_id : null));

      // Best-effort online submit if not yet synced (e.g. offline at submit, online now).
      // Anything that doesn't land here is queued for automatic background retry (Story
      // 4.1) instead of being left to sit as `pending` forever.
      if (draft.canonical_id) return;
      const officerRecord: PoCRecord = {
        ...record,
        submitted_by_officer: true,
        officer_id: typeof draft.officer_id === "string" ? draft.officer_id : undefined,
      };

      let token: string | null = null;
      try {
        const supabase = createClient();
        const { data } = await supabase.auth.getSession();
        token = data.session?.access_token ?? null;
      } catch {
        token = null;
      }

      if (!active) return;
      if (!token) {
        await enqueueCase(draftId, buildCasePayload(officerRecord)).catch(() => {});
        return;
      }

      const submitResult = await submitCaseOnline(officerRecord, token);
      if (!active) return;
      if (!submitResult) {
        await enqueueCase(draftId, buildCasePayload(officerRecord)).catch(() => {});
        return;
      }
      setCanonicalId(submitResult.canonical_id);
      await updateDraft(draftId, {
        canonical_id: submitResult.canonical_id,
        sync_status: "synced",
      }).catch(() => {});
    })().catch(() => {
      /* PoC already rendered; sync retries later (Story 4.1) */
    });

    return () => {
      active = false;
    };
  }, [router]);

  // Story 4.3: pick up a background sync that completes while this page is still open,
  // without waiting for a reload (dispatched by lib/syncQueue.ts::runSync on success).
  // Matches against draftIdRef (set synchronously on mount) rather than `poc` state, so a
  // sync that completes before the async getCase/buildPoC chain resolves is never missed.
  useEffect(() => {
    function handleSynced(e: Event) {
      const evt = e as CustomEvent<{ offline_id?: string; canonical_id?: string } | undefined>;
      if (evt.detail && evt.detail.offline_id === draftIdRef.current) {
        setCanonicalId(evt.detail.canonical_id ?? null);
      }
    }
    window.addEventListener("hec-case-synced", handleSynced);
    return () => window.removeEventListener("hec-case-synced", handleSynced);
  }, []);

  if (!poc) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-surface-base" role="status" aria-live="polite">
        <span className="h-8 w-8 animate-spin rounded-full border-2 border-border-default border-t-forest" aria-hidden="true" />
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-design-6 bg-surface-base px-design-4 py-design-6">
      {/* This screen deliberately carries no OfficerTopBar / step rail — it is a terminal receipt
          the officer holds out for the citizen to read, and app chrome would compete with it. It
          still needs a heading, though: every other officer route gained an <h1> with the top bar,
          and the CITIZEN receipt has had one since Story 2.4 (report/poc: `poc.successTitle`).
          Without this the page had no heading at ANY level — PoCCard's reference number is a
          styled <p>, and its `aria-label` names a region, which is not a heading. */}
      <h1 className="text-center text-headline text-ink-primary print:hidden">
        {t("submitPoc.title")}
      </h1>

      <PoCCard poc={poc} canonicalId={canonicalId} />

      <section
        aria-label={t("submitPoc.detailsLabel")}
        className="mx-auto flex w-full max-w-md flex-col gap-design-3 rounded-md border border-border-default bg-surface-raised p-design-4"
      >
        <div className="flex items-center justify-between gap-design-3">
          <span className="text-label text-ink-secondary">{t("submitPoc.citizenNic")}</span>
          <span data-testid="citizen-nic-mask" className="text-label font-semibold text-ink-primary">
            {nicLast4 ? `••••••••${nicLast4}` : "••••••••"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-design-3">
          <span className="text-label text-ink-secondary">{t("submitPoc.submittedByOfficer")}</span>
          <span
            data-testid="officer-badge"
            className="rounded-pill bg-forest-pale px-design-3 py-design-1 text-caption font-semibold text-forest break-all"
          >
            {officerId ?? t("submitPoc.officerFallback")}
          </span>
        </div>
      </section>

      <button
        type="button"
        onClick={() => {
          // Explicit case-boundary reset (P1/P3): clear the draft id and the carried NIC mask
          // so the next citizen's submission starts from a clean slate rather than reusing —
          // and colliding on — this offline_id.
          clearDraftId();
          clearOfficerPocMask();
          router.push("/officer/submit");
        }}
        className="w-full min-h-primary-btn bg-forest text-ink-on-dark text-headline font-semibold rounded-md"
      >
        {t("submitPoc.submitAnother")}
      </button>
    </main>
  );
}
