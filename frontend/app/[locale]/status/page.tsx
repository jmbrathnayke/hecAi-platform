"use client";
// Public claim-status lookup (Story 2.5, FR-6.1). No login. Enter a reference number
// (HEC-YYYY-NNNN or UUID-v4) or scan the PoC QR; shows status metadata only.
//
// THE LOOKUP LOGIC BELOW IS UNCHANGED. What was rebuilt is the presentation: this is the channel
// that still works when push and email have both failed (§5.9), and for many families it is
// the only part of the platform they will ever see. It was a bare heading, an input and a flat
// list of four fields on a narrow column adrift in an empty page. It now reads as the official
// service it is: an identifying header, guidance before the first search, and an answer that leads
// with the outcome.
import { useEffect, useState } from "react";
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
    // No reference contains whitespace, so any is a transcription slip ("HEC-2026- 0281" typed from
    // a printed receipt), not a different reference.
    const trimmed = ref.replace(/\s+/g, "");
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

  // A tapped notification or a shared link arrives as /status?ref=HEC-YYYY-NNNN. Read once on
  // mount from window.location rather than useSearchParams(), which would force a Suspense boundary
  // around a page that is otherwise statically rendered.
  useEffect(() => {
    let ref: string | null = null;
    try {
      ref = new URLSearchParams(window.location.search).get("ref");
    } catch {
      ref = null;
    }
    if (ref) {
      setReference(ref);
      void handleCheck(ref);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once, for the landing URL only
  }, []);

  function handleQRResult(decoded: string) {
    setShowScanner(false);
    setReference(decoded);
    void handleCheck(decoded);
  }

  return (
    <main className="flex-1 bg-surface-base pb-design-8">
      {/* Identifying band. A citizen arriving from a QR code on a paper form has no other cue that
          this is the department's own service and not a lookalike. */}
      <header className="border-b border-border-subtle bg-surface-raised">
        <div className="mx-auto flex w-full max-w-2xl items-center gap-design-3 px-design-5 py-design-4">
          <span aria-hidden="true" className="text-title">
            🌿
          </span>
          <div className="min-w-0">
            <p className="truncate text-label font-semibold text-ink-primary">
              {t("serviceName")}
            </p>
            <p className="truncate text-caption text-ink-secondary">{t("serviceTag")}</p>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-design-5 px-design-5 py-design-6">
        <div>
          <h1 className="text-display text-ink-primary">{t("title")}</h1>
          <p className="mt-design-2 text-body text-ink-secondary">{t("intro")}</p>
        </div>

        <div className="flex flex-col gap-design-4 rounded-md border border-border-subtle bg-surface-raised p-design-5 shadow-card">
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
              onKeyDown={(e) => {
                // A reference is one field and one action; Enter is what a person will press.
                if (e.key === "Enter") void handleCheck();
              }}
              placeholder={t("inputPlaceholder")}
              className="min-h-touch-target rounded-md border border-border-default bg-surface-raised px-design-4 font-mono text-body text-ink-primary transition-shadow duration-quick focus:border-border-focus focus:shadow-focus focus:outline-none"
            />
          </div>

          <div className="flex flex-col gap-design-3 sm:flex-row">
            <button
              type="button"
              disabled={loading}
              onClick={() => void handleCheck()}
              className="flex min-h-primary-btn flex-1 items-center justify-center rounded-md bg-amber px-design-4 text-label font-semibold text-ink-on-amber transition-opacity duration-quick hover:opacity-90 disabled:opacity-60"
            >
              {loading ? "…" : t("check")}
            </button>
            <button
              type="button"
              onClick={() => setShowScanner((s) => !s)}
              className="flex min-h-primary-btn flex-1 items-center justify-center rounded-md border border-forest px-design-4 text-label font-semibold text-forest transition-colors duration-quick hover:bg-forest-pale"
            >
              {t("scanQR")}
            </button>
          </div>

          {showScanner && <QRScanner onResult={handleQRResult} />}
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-md border border-status-error bg-status-error-pale px-design-4 py-design-3 text-body text-status-error"
          >
            {error}
          </p>
        )}

        {result && <StatusCard {...result} />}

        {/* Standing in for the result before the first search, so the page is never a form over
            blank space. Suppressed once there is either an answer or an error to show. */}
        {!result && !error && (
          <div className="rounded-md border border-dashed border-border-default px-design-5 py-design-6 text-center">
            <p className="text-headline text-ink-primary">{t("emptyTitle")}</p>
            <p className="mx-auto mt-design-2 max-w-sm text-body text-ink-secondary">
              {t("emptyBody")}
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
