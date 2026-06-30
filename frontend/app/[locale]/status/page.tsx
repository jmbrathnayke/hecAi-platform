"use client";
// Public claim-status lookup (Story 2.5, FR-6.1). No login. Enter a reference number
// (HEC-YYYY-NNNN or UUID-v4) or scan the PoC QR; shows status metadata only.
import { useState } from "react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { StatusCard } from "@/components/StatusCard";
import { isValidReference, type CaseStatus } from "@/lib/status";

// Camera APIs are client-only.
const QRScanner = dynamic(() => import("@/components/QRScanner"), { ssr: false });

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export default function StatusPage() {
  const t = useTranslations("status");
  const [reference, setReference] = useState("");
  const [result, setResult] = useState<CaseStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showScanner, setShowScanner] = useState(false);

  async function handleCheck(ref: string = reference) {
    const trimmed = ref.trim();
    if (!trimmed || loading) return;
    setResult(null);
    // Client-side format gate avoids a pointless request and never reveals server internals.
    if (!isValidReference(trimmed)) {
      setError(t("notFound"));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `${API_BASE}/api/v1/cases/status/${encodeURIComponent(trimmed)}`,
      );
      // Only a 404 means the reference genuinely doesn't exist. A 5xx/other status is a
      // service problem — don't tell a citizen with a valid reference it wasn't found.
      if (res.status === 404) {
        setError(t("notFound"));
        return;
      }
      if (!res.ok) {
        setError(t("serviceError"));
        return;
      }
      setResult((await res.json()) as CaseStatus);
    } catch {
      // Network failure / fetch threw — also a service problem, not a missing reference.
      setError(t("serviceError"));
    } finally {
      setLoading(false);
    }
  }

  function handleQRResult(decoded: string) {
    setShowScanner(false);
    setReference(decoded);
    void handleCheck(decoded);
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-design-5 bg-surface-base px-design-5 py-design-6">
      <h1 className="text-title font-bold text-ink-primary">{t("title")}</h1>

      <div className="flex flex-col gap-design-2">
        <label htmlFor="reference" className="text-label font-medium text-ink-primary">
          {t("inputLabel")}
        </label>
        <input
          id="reference"
          type="text"
          inputMode="text"
          autoComplete="off"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder={t("inputPlaceholder")}
          className="min-h-touch-target rounded-md border border-border-default bg-surface-raised px-design-3 text-body text-ink-primary focus:border-border-focus focus:outline-none"
        />
      </div>

      <div className="flex gap-design-3">
        <button
          type="button"
          disabled={loading}
          onClick={() => void handleCheck()}
          className="flex flex-1 min-h-primary-btn items-center justify-center rounded-md bg-amber px-design-4 text-label font-semibold text-ink-on-amber transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {loading ? "…" : t("check")}
        </button>
        <button
          type="button"
          onClick={() => setShowScanner((s) => !s)}
          className="flex flex-1 min-h-primary-btn items-center justify-center rounded-md border border-forest px-design-4 text-label font-semibold text-forest transition-opacity hover:opacity-90"
        >
          {t("scanQR")}
        </button>
      </div>

      {showScanner && <QRScanner onResult={handleQRResult} />}

      {error && (
        <p role="alert" className="text-caption text-status-error">
          {error}
        </p>
      )}

      {result && <StatusCard {...result} />}
    </main>
  );
}
