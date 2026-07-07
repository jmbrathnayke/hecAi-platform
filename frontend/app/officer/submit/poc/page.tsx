"use client";

// Officer PoC receipt (Story 3.5, AC6). Renders the citizen's Proof of Claim after an
// officer-assisted submission: reuses the existing PoCCard (QR of the offline_id via
// qrcode.react + reference + timestamp) and composes an officer-ID badge and the citizen
// NIC masked to its last 4 chars around it. English-only officer portal (FR-9.3) — PoCCard
// uses next-intl, so it is wrapped in a minimal NextIntlClientProvider seeded with the English
// `poc` messages (the officer tree has no i18n provider of its own).
//
// Offline-first (CRITICAL #3): the receipt is built from the persisted draft and shown
// immediately; a best-effort online submit only upgrades the reference to the canonical id.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import enMessages from "@/messages/en.json";
import { PoCCard } from "@/components/PoCCard";
import { getCase, updateDraft } from "@/lib/indexeddb";
import { getDraftId, clearDraftId } from "@/lib/draft";
import { buildPoC, submitCaseOnline, type PoCRecord } from "@/lib/poc";
import { createClient } from "@/lib/supabase";
import { OFFICER_POC_NIC_KEY, clearOfficerPocMask } from "@/lib/officerPoc";

export default function OfficerPoCPage() {
  const router = useRouter();
  const [poc, setPoc] = useState<PoCRecord | null>(null);
  const [canonicalId, setCanonicalId] = useState<string | null>(null);
  const [officerId, setOfficerId] = useState<string | null>(null);
  const [nicLast4, setNicLast4] = useState<string | null>(null);

  useEffect(() => {
    const draftId = getDraftId();
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
      setCanonicalId(typeof draft.canonical_id === "string" ? draft.canonical_id : null);

      // Best-effort online submit if not yet synced (e.g. offline at submit, online now).
      if (draft.canonical_id) return;
      let token: string | null = null;
      try {
        const supabase = createClient();
        const { data } = await supabase.auth.getSession();
        token = data.session?.access_token ?? null;
      } catch {
        return;
      }
      if (!token || !active) return;
      const submitResult = await submitCaseOnline(
        { ...record, submitted_by_officer: true, officer_id: typeof draft.officer_id === "string" ? draft.officer_id : undefined },
        token,
      );
      if (!active || !submitResult) return;
      setCanonicalId(submitResult.canonical_id);
      await updateDraft(draftId, {
        canonical_id: submitResult.canonical_id,
        sync_status: "synced",
      }).catch(() => {});
    })().catch(() => {
      /* PoC already rendered; sync retries later (Epic 4) */
    });

    return () => {
      active = false;
    };
  }, [router]);

  if (!poc) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-surface-base" role="status" aria-live="polite">
        <span className="h-8 w-8 animate-spin rounded-full border-2 border-border-default border-t-forest" aria-hidden="true" />
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-design-6 bg-surface-base px-design-4 py-design-6">
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PoCCard poc={poc} canonicalId={canonicalId} />
      </NextIntlClientProvider>

      <section
        aria-label="Officer-assisted submission details"
        className="mx-auto flex w-full max-w-md flex-col gap-design-3 rounded-md border border-border-default bg-surface-raised p-design-4"
      >
        <div className="flex items-center justify-between gap-design-3">
          <span className="text-label text-ink-secondary">Citizen NIC</span>
          <span data-testid="citizen-nic-mask" className="text-label font-semibold text-ink-primary">
            {nicLast4 ? `••••••••${nicLast4}` : "••••••••"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-design-3">
          <span className="text-label text-ink-secondary">Submitted by officer</span>
          <span
            data-testid="officer-badge"
            className="rounded-pill bg-forest-pale px-design-3 py-design-1 text-caption font-semibold text-forest break-all"
          >
            {officerId ?? "Officer"}
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
        Submit another citizen
      </button>
    </main>
  );
}
