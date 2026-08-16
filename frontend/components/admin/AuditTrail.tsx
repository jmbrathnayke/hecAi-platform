"use client";

// Audit trail viewer (Story 5.4 AC4). Renders THIS case's audit events (a simple
// case-scoped list, chronological) plus a "Verify chain integrity" action that calls the
// backend's GET /api/v1/admin/audit/verify-chain — a GLOBAL, server-side check over the
// whole audit_log table. Deliberately NOT a client-side recomputation: the hash chain links
// every row in the table in insertion order regardless of case, so a case-filtered "verify"
// would compare against the wrong previous hash and be cryptographically meaningless (see
// the story's CRITICAL #3/#6 and infrastructure/audit.py's own docstring).
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { getAccessToken } from "@/lib/auth";
import { verifyAuditChain, UNAUTHORIZED, type AdminAuditEntry } from "@/lib/adminCaseDetail";

interface AuditTrailProps {
  trail: AdminAuditEntry[];
}

type VerifyState = "idle" | "checking" | "valid" | "invalid" | "error" | "unauthorized";

function formatTimestamp(iso: string | null, locale: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(locale);
}

export function AuditTrail({ trail }: AuditTrailProps) {
  const t = useTranslations("admin");
  const locale = useLocale();
  const [verifyState, setVerifyState] = useState<VerifyState>("idle");
  // Code review fix: the backend deliberately returns an opaque audit_log.id for the broken
  // row (safe -- no case/district join) specifically so something actionable could be shown;
  // the UI previously discarded it, leaving admins with a generic message they couldn't act on.
  const [brokenId, setBrokenId] = useState<number | null>(null);

  async function handleVerify() {
    setVerifyState("checking");
    const token = await getAccessToken();
    if (!token) {
      setVerifyState("unauthorized");
      return;
    }
    const result = await verifyAuditChain(token);
    if (result === UNAUTHORIZED) {
      setVerifyState("unauthorized");
      return;
    }
    if (!result) {
      setVerifyState("error");
      return;
    }
    setBrokenId(result.broken_id);
    setVerifyState(result.valid ? "valid" : "invalid");
  }

  return (
    <div className="space-y-design-3">
      <div className="flex items-center justify-between">
        {/* was `text-heading-3` — undefined token; see AIResultPanel. DESIGN.md § Typography. */}
        <h3 className="text-headline text-ink-primary">{t("audit.heading")}</h3>
        <button
          type="button"
          onClick={handleVerify}
          disabled={verifyState === "checking"}
          className="text-label font-medium text-forest underline disabled:opacity-50"
        >
          {t("audit.verify")}
        </button>
      </div>

      {verifyState === "valid" && (
        <p className="text-label text-forest" role="status">
          {t("audit.valid")}
        </p>
      )}
      {verifyState === "invalid" && (
        <p className="text-label text-status-error" role="alert">
          {brokenId != null
            ? t("audit.invalidWithRow", { row: brokenId })
            : t("audit.invalidNoRow")}
        </p>
      )}
      {verifyState === "unauthorized" && (
        <p className="text-label text-status-error" role="alert">
          {t("audit.unauthorized")}
        </p>
      )}
      {verifyState === "error" && (
        <p className="text-label text-status-error" role="alert">
          {t("audit.error")}
        </p>
      )}

      <div className="space-y-design-2">
        {trail.map((entry) => (
          <div
            key={entry.id}
            className="rounded-md border border-border-default bg-surface-raised p-design-3"
          >
            <div className="flex flex-wrap items-center gap-design-2">
              <span className="text-label font-medium text-ink-primary">{entry.event}</span>
              <span className="text-label text-ink-disabled">{entry.actor_id ?? "—"}</span>
              <span className="ml-auto text-caption text-ink-disabled">
                {formatTimestamp(entry.created_at, locale)}
              </span>
            </div>
            {entry.hash && (
              <p className="mt-1 font-mono text-caption text-ink-disabled">
                {entry.hash.slice(0, 16)}…
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
