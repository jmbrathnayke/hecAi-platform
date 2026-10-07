"use client";

// Case detail panel (Story 5.4, AC1-5). Mounted inside the EXISTING Story 5.3 split-pane
// seam (frontend/app/admin/cases/page.tsx's selectedDetailContent) — this is not a
// standalone page/route (see the story's CRITICAL #4: no [id]/page.tsx).
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { getAccessToken } from "@/lib/auth";
import { fetchAdminCaseDetail, UNAUTHORIZED, type AdminCaseDetailResponse } from "@/lib/adminCaseDetail";
import { PhotoGallery } from "@/components/admin/PhotoGallery";
import { ClaimantDetails } from "@/components/ClaimantDetails";
import { AIResultPanel } from "@/components/admin/AIResultPanel";
import { CompensationPanel } from "@/components/admin/CompensationPanel";
import { AuditTrail } from "@/components/admin/AuditTrail";
import { CaseActionPanel } from "@/components/admin/CaseActionPanel";
import { isKnownStage, statusKey } from "@/lib/status";
import { STATUS_STYLES, STATUS_VALUES } from "@/components/admin/statusVocabulary";
import { DAMAGE_CATEGORY_KEYS } from "@/components/admin/damageVocabulary";

interface CaseDetailPanelProps {
  offlineId: string;
}

type LoadState = "loading" | "error" | "ready";

function formatDateTime(iso: string | null, locale: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(locale);
}

export function CaseDetailPanel({ offlineId }: CaseDetailPanelProps) {
  const router = useRouter();
  const t = useTranslations("admin");
  const tStatus = useTranslations("status");
  const tReport = useTranslations("report");
  const locale = useLocale();
  const [data, setData] = useState<AdminCaseDetailResponse | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [reloadNonce, setReloadNonce] = useState(0);
  const requestIdRef = useRef(0);

  useEffect(() => {
    // Guard against the standing Epic-2-retro lifecycle-race class: an in-flight fetch for
    // a previous offlineId must not clobber state after the admin has already clicked a
    // different row.
    const requestId = ++requestIdRef.current;
    let active = true;
    setData(null);
    setState("loading");

    (async () => {
      const token = await getAccessToken();
      if (!token) {
        if (active && requestIdRef.current === requestId) setState("error");
        return;
      }
      const result = await fetchAdminCaseDetail(token, offlineId);
      if (!active || requestIdRef.current !== requestId) return;
      if (result === UNAUTHORIZED) {
        router.replace("/admin/login");
        return;
      }
      if (!result) {
        setState("error");
        return;
      }
      setData(result);
      setState("ready");
    })();

    return () => {
      active = false;
    };
    // router omitted (matches page.tsx's existing fetch effect) -- useRouter()'s identity
    // is stable in the real app, but including it here is a needless extra trigger surface.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offlineId, reloadNonce]);

  if (state === "loading") {
    return (
      <div className="rounded-md border border-border-subtle bg-surface-raised shadow-card p-design-4">
        <p className="text-body text-ink-secondary" role="status">
          {t("detail.loading")}
        </p>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div role="alert" className="space-y-design-2 rounded-md border border-border-subtle bg-surface-raised shadow-card p-design-4">
        <p className="text-body text-status-error">{t("detail.loadError")}</p>
        <button
          type="button"
          onClick={() => setReloadNonce((n) => n + 1)}
          className="min-h-touch-target rounded-md border border-forest px-design-4 text-label font-semibold text-forest"
        >
          {t("detail.retry")}
        </button>
      </div>
    );
  }

  if (!data) return null;

  const { case: c, ai_result, compensation, audit_trail, workflow } = data;
  const hasGps = c.gps_lat != null && c.gps_lng != null;
  // Verified = an officer was present at submission, or has since assessed the citizen's report.
  const verified = workflow ? workflow.officer_assessed : c.submitted_by_officer;
  const stageKnown = workflow ? isKnownStage(workflow.stage) : false;

  return (
    <div className="space-y-design-4">
      <div className="rounded-md border border-border-subtle bg-surface-raised shadow-card p-design-4 space-y-design-2">
        <div className="flex items-center gap-design-3">
          {/* was `text-heading-3`, which has never existed in tailwind.config.ts — and because
              preflight resets h1-h6 to `font-size/font-weight: inherit`, this rendered at plain
              body size and weight. DESIGN.md's Title tier names "Case #HEC-2026-0042" as its
              own example, so this is the tier it was always meant to be. */}
          <h2 className="text-title text-ink-primary">{c.canonical_id ?? "—"}</h2>
          {/* Status (Story 5.5 Task 5) -- not previously rendered anywhere in this panel;
              the action panel's own button set depends on it, so the admin needs to see it
              too. Reuses the same badge styling as CaseListTable's status column. */}
          <span
            className={`rounded-full px-design-2 py-0.5 text-caption font-medium ${
              STATUS_STYLES[c.status] ?? "bg-surface-tint text-ink-secondary"
            }`}
          >
            {(STATUS_VALUES as readonly string[]).includes(c.status)
              ? tStatus(`statusLabels.${statusKey(c.status)}`)
              : c.status}
          </span>
        </div>
        <dl className="grid grid-cols-2 gap-design-2 text-body">
          <div>
            <dt className="text-label text-ink-disabled">{t("detail.channel")}</dt>
            <dd className="text-ink-primary">{c.submitted_via ?? "—"}</dd>
          </div>
          {/* This panel is where the approve/reject decision is taken, so the verification state
              belongs here and not only in the list. `channel` above cannot answer it: it reads
              "app" whether an officer stood in the field or the citizen sat at home. */}
          <div>
            <dt className="text-label text-ink-disabled">{t("detail.verification")}</dt>
            <dd
              className={
                verified
                  ? "text-ink-primary"
                  : "font-medium text-ink-primary"
              }
            >
              {verified
                ? t("table.verifiedByOfficer")
                : `⚠ ${t("table.notVerified")}`}
            </dd>
          </div>
          <div>
            <dt className="text-label text-ink-disabled">{t("detail.damageCategory")}</dt>
            <dd className="text-ink-primary">
              {c.damage_category
                ? DAMAGE_CATEGORY_KEYS.has(c.damage_category)
                  ? tReport(`step3.${c.damage_category}`)
                  : c.damage_category
                : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-label text-ink-disabled">{t("detail.submitted")}</dt>
            <dd className="text-ink-primary">{formatDateTime(c.submitted_at, locale)}</dd>
          </div>
          <div>
            <dt className="text-label text-ink-disabled">{t("detail.location")}</dt>
            <dd className="text-ink-primary">
              {hasGps ? (
                <a
                  href={`https://www.google.com/maps?q=${c.gps_lat},${c.gps_lng}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-forest underline"
                >
                  {c.gps_lat}, {c.gps_lng}
                </a>
              ) : (
                "—"
              )}
            </dd>
          </div>
        </dl>
      </div>

      {workflow && (
        // Where the case is in the governance workflow, organised by area and responsible officer.
        <div className="rounded-md border border-border-subtle bg-surface-raised shadow-card p-design-4 space-y-design-2" data-testid="workflow-panel">
          <h3 className="text-headline text-ink-primary">{t("workflow.heading")}</h3>
          <dl className="grid grid-cols-2 gap-design-2 text-body">
            <div>
              <dt className="text-label text-ink-disabled">{t("workflow.stage")}</dt>
              <dd className="text-ink-primary">
                {stageKnown ? tStatus(`stageLabels.${workflow.stage}`) : workflow.stage}
              </dd>
            </div>
            <div>
              <dt className="text-label text-ink-disabled">{t("workflow.district")}</dt>
              <dd className="text-ink-primary">{workflow.district ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-label text-ink-disabled">{t("workflow.division")}</dt>
              <dd className="text-ink-primary">{workflow.ds_division ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-label text-ink-disabled">{t("workflow.officer")}</dt>
              <dd className="break-all font-mono text-caption text-ink-primary">{workflow.responsible_officer_id ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-label text-ink-disabled">{t("workflow.assessedAt")}</dt>
              <dd className="text-ink-primary">
                {workflow.officer_assessed_at
                  ? formatDateTime(workflow.officer_assessed_at, locale)
                  : c.submitted_by_officer
                    ? t("table.verifiedByOfficer")
                    : t("workflow.notAssessed")}
              </dd>
            </div>
            <div data-testid="workflow-ds-final">
              <dt className="text-label text-ink-disabled">{t("workflow.dsFinal")}</dt>
              <dd className="text-ink-primary">
                {workflow.ds_final_amount != null
                  ? `Rs. ${workflow.ds_final_amount.toLocaleString("en-LK")} · ${formatDateTime(workflow.ds_final_at, locale)}`
                  : t("workflow.dsFinalPending")}
              </dd>
              {workflow.ds_final_reason && (
                <dd className="text-caption text-ink-secondary">
                  {t("workflow.dsFinalReason")}: {workflow.ds_final_reason}
                </dd>
              )}
            </div>
          </dl>
        </div>
      )}

      {/* The admin route keys on offline_id; the endpoint accepts either that or the canonical
          id, so the panel passes what it already has rather than waiting for a canonical id a
          just-synced case may not carry yet. */}
      {/* Whose claim this is: an approval has to be of a named household, not a reference. */}
      <ClaimantDetails caseRef={c.canonical_id ?? offlineId} />
      {/* The family's own words about the damage (migration 040), read beside their photographs:
          an approval that never read the claim is not a review of it. */}
      <div className="rounded-md border border-border-subtle bg-surface-raised p-design-4" data-testid="admin-citizen-description">
        <h3 className="text-label font-semibold text-ink-primary">{t("citizenDescription.heading")}</h3>
        <p className={`mt-design-1 whitespace-pre-wrap text-body ${c.citizen_description ? "text-ink-primary" : "text-ink-disabled"}`}>
          {c.citizen_description || t("citizenDescription.none")}
        </p>
      </div>
      <PhotoGallery caseRef={c.canonical_id ?? offlineId} />
      <AIResultPanel aiResult={ai_result} />
      <CompensationPanel compensation={compensation} />
      <AuditTrail trail={audit_trail} />
      <CaseActionPanel
        offlineId={offlineId}
        status={c.status}
        hasEstimate={compensation != null}
        estimateAmountLkr={compensation?.amount_lkr ?? null}
        onActionComplete={setData}
        officerAssessed={workflow ? workflow.officer_assessed : undefined}
        dsFinalDecided={workflow ? workflow.ds_final_amount != null : undefined}
      />
    </div>
  );
}
