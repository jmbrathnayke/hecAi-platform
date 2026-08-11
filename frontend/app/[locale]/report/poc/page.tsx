"use client";
// PoC screen: builds the Proof of Claim from the draft and renders it IMMEDIATELY
// (offline-first, FR-3.2). If online and an auth token is available it submits in the
// background and upgrades the reference to the canonical HEC-YYYY-NNNN — the QR/receipt
// never blocks on the network (CRITICAL #3).
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Link, useRouter } from "@/navigation";
import { PoCCard } from "@/components/PoCCard";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { getCase, updateDraft } from "@/lib/indexeddb";
import { getDraftId } from "@/lib/draft";
import { getAccessToken } from "@/lib/auth";
import { buildPoC, submitCaseOnline, type PoCRecord } from "@/lib/poc";

export default function PoCPage() {
  const t = useTranslations("poc");
  const router = useRouter();
  const { isOnline } = useOnlineStatus();

  const [poc, setPoc] = useState<PoCRecord | null>(null);
  const [canonicalId, setCanonicalId] = useState<string | null>(null);
  const [canShare, setCanShare] = useState(false);
  // Known synchronously from mount (unlike `poc`, which is only set after the async
  // getCase/buildPoC chain resolves) — lets the sync-event listener below match a case
  // even if the event fires before `poc` is ready (review patch: closes that race).
  const draftIdRef = useRef<string | null>(null);

  useEffect(() => {
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");

    const draftId = getDraftId();
    draftIdRef.current = draftId;
    if (!draftId) {
      router.replace("/report");
      return;
    }

    let active = true;
    (async () => {
      const draft = await getCase(draftId);
      if (!active || !draft) {
        if (active) router.replace("/report");
        return;
      }
      const record = await buildPoC(draft);
      if (!active) return;
      setPoc(record);
      // Functional update: don't clobber a canonical id the hec-case-synced listener may
      // already have set from a sync that completed while this async chain was in flight
      // (review patch) — the draft read here can be stale relative to that live event.
      setCanonicalId((prev) => prev ?? (typeof draft.canonical_id === "string" ? draft.canonical_id : null));

      // Best-effort online submission (does not block the receipt above).
      if (!navigator.onLine || draft.canonical_id) return;
      const token = await getAccessToken();
      if (!token || !active) return;
      const result = await submitCaseOnline(record, token);
      if (!active || !result) return;
      setCanonicalId(result.canonical_id);
      await updateDraft(draftId, { canonical_id: result.canonical_id, sync_status: "synced" }).catch(
        () => {},
      );
    })().catch(() => {
      /* PoC already rendered; sync retries later (Epic 4) */
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

  // Render a self-contained PoC card (title + reference + QR + timestamp) to a PNG.
  // Uses the SVG QR drawn onto a canvas — no html2canvas (CRITICAL #5).
  function downloadPoCPng() {
    const svg = document.querySelector<SVGSVGElement>("#poc-qr svg");
    if (!svg || !poc) return;
    const reference = canonicalId ?? poc.offline_id;
    const timestamp = new Date(poc.timestamp_local).toLocaleString();
    const xml = new XMLSerializer().serializeToString(svg);
    const svgUrl = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml" }));

    const img = new Image();
    img.onerror = () => URL.revokeObjectURL(svgUrl);
    img.onload = () => {
      const W = 300;
      const QR = 180;
      const H = 336;
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, W, H);
        ctx.textAlign = "center";
        ctx.fillStyle = "#14532d";
        ctx.font = "bold 20px sans-serif";
        ctx.fillText(t("title"), W / 2, 40);
        ctx.fillStyle = "#6b7280";
        ctx.font = "11px sans-serif";
        ctx.fillText(t("canonicalLabel").toUpperCase(), W / 2, 68);
        ctx.fillStyle = "#111827";
        ctx.font = "13px monospace";
        ctx.fillText(reference, W / 2, 90);
        ctx.drawImage(img, (W - QR) / 2, 108, QR, QR);
        ctx.fillStyle = "#6b7280";
        ctx.font = "12px sans-serif";
        ctx.fillText(timestamp, W / 2, 314);
        canvas.toBlob((blob) => {
          if (!blob) return;
          const href = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = href;
          a.download = `proof-of-claim-${poc.offline_id}.png`;
          a.click();
          URL.revokeObjectURL(href);
        }, "image/png");
      }
      URL.revokeObjectURL(svgUrl);
    };
    img.src = svgUrl;
  }

  async function handleShare() {
    if (!poc) return;
    try {
      await navigator.share({
        title: t("title"),
        text: `${canonicalId ?? poc.offline_id}`,
      });
    } catch {
      /* user cancelled or share failed — no-op */
    }
  }

  if (!poc) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-surface-base" role="status" aria-live="polite">
        <span className="h-8 w-8 animate-spin rounded-full border-2 border-border-default border-t-forest" aria-hidden="true" />
      </main>
    );
  }

  const reference = canonicalId ?? poc.offline_id;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-design-4 bg-surface-base px-design-4 py-design-5 print:p-0">
      {/* Success zone (proof-of-claim.html) — confirms receipt before the card itself, so the
          citizen sees "we have your report" without having to parse the receipt. */}
      <div className="text-center print:hidden">
        <span
          className="inline-flex h-16 w-16 items-center justify-center rounded-full border-[3px] border-forest-mid bg-forest-pale text-[32px] text-forest"
          aria-hidden="true"
        >
          ✓
        </span>
        <h1 className="mt-design-3 text-headline text-ink-primary">{t("successTitle")}</h1>
        <p className="mt-design-1 text-label text-ink-secondary">{t("successBody")}</p>
      </div>

      <PoCCard poc={poc} canonicalId={canonicalId} />

      {!isOnline && !canonicalId && (
        <p role="status" className="text-center text-caption text-status-warning print:hidden">
          {t("offlineNotice")}
        </p>
      )}

      {/* Reminder strip — tells the citizen what happens next and repeats the reference. */}
      <aside className="flex items-start gap-design-2 rounded-md bg-forest-pale p-design-3 print:hidden">
        <span className="shrink-0 text-[16px] leading-tight" aria-hidden="true">
          💡
        </span>
        <p className="text-caption leading-relaxed text-forest">
          {t("reminder", { ref: reference })}
        </p>
      </aside>

      {/* Actions. Share is the mockup's amber primary; Print is the outline secondary. They
          stack on narrow screens so two wrapped Sinhala/Tamil labels don't squeeze each other. */}
      <div className="flex flex-col gap-design-2 print:hidden sm:flex-row sm:gap-design-3">
        {canShare ? (
          <button
            type="button"
            onClick={() => void handleShare()}
            className="flex min-h-primary-btn flex-1 items-center justify-center rounded-lg bg-amber px-design-4 text-label font-bold text-ink-on-amber transition-opacity hover:opacity-90"
          >
            {t("share")}
          </button>
        ) : (
          <button
            type="button"
            onClick={downloadPoCPng}
            className="flex min-h-primary-btn flex-1 items-center justify-center rounded-lg bg-amber px-design-4 text-label font-bold text-ink-on-amber transition-opacity hover:opacity-90"
          >
            {t("download")}
          </button>
        )}
        <button
          type="button"
          onClick={() => window.print()}
          className="flex min-h-primary-btn flex-1 items-center justify-center rounded-lg border-2 border-forest px-design-4 text-label font-semibold text-forest transition-opacity hover:opacity-90"
        >
          {t("print")}
        </button>
      </div>

      {/* Terminal CTA — this screen is the end of the report flow and (per the mockup) carries
          no tab bar, so it needs its own way back. */}
      <Link
        href="/"
        className="flex min-h-touch-target items-center justify-center rounded-lg border border-border-default px-design-4 text-label font-medium text-ink-secondary print:hidden"
      >
        {t("done")}
      </Link>
    </main>
  );
}
