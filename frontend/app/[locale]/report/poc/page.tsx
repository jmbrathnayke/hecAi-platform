"use client";
// PoC screen: builds the Proof of Claim from the draft and renders it IMMEDIATELY
// (offline-first, FR-3.2). If online and an auth token is available it submits in the
// background and upgrades the reference to the canonical HEC-YYYY-NNNN — the QR/receipt
// never blocks on the network (CRITICAL #3).
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/navigation";
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

  useEffect(() => {
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");

    const draftId = getDraftId();
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
      setCanonicalId(typeof draft.canonical_id === "string" ? draft.canonical_id : null);

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
  useEffect(() => {
    function handleSynced(e: Event) {
      const evt = e as CustomEvent<{ offline_id: string; canonical_id: string }>;
      if (poc && evt.detail.offline_id === poc.offline_id) {
        setCanonicalId(evt.detail.canonical_id);
      }
    }
    window.addEventListener("hec-case-synced", handleSynced);
    return () => window.removeEventListener("hec-case-synced", handleSynced);
  }, [poc]);

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

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-design-6 bg-surface-base px-design-4 py-design-6 print:p-0">
      <PoCCard poc={poc} canonicalId={canonicalId} />

      {!isOnline && !canonicalId && (
        <p role="status" className="text-center text-caption text-status-warning print:hidden">
          {t("offlineNotice")}
        </p>
      )}

      <div className="flex gap-design-3 print:hidden">
        {canShare ? (
          <button
            type="button"
            onClick={() => void handleShare()}
            className="flex flex-1 min-h-primary-btn items-center justify-center rounded-md bg-forest px-design-4 text-label font-semibold text-ink-on-dark transition-opacity hover:opacity-90"
          >
            {t("share")}
          </button>
        ) : (
          <button
            type="button"
            onClick={downloadPoCPng}
            className="flex flex-1 min-h-primary-btn items-center justify-center rounded-md bg-forest px-design-4 text-label font-semibold text-ink-on-dark transition-opacity hover:opacity-90"
          >
            {t("download")}
          </button>
        )}
        <button
          type="button"
          onClick={() => window.print()}
          className="flex flex-1 min-h-primary-btn items-center justify-center rounded-md border border-forest px-design-4 text-label font-semibold text-forest transition-opacity hover:opacity-90"
        >
          {t("print")}
        </button>
      </div>
    </main>
  );
}
