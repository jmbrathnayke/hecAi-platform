"use client";

// Case detail panel (Story 5.4, AC1-5). Mounted inside the EXISTING Story 5.3 split-pane
// seam (frontend/app/admin/cases/page.tsx's selectedDetailContent) — this is not a
// standalone page/route (see the story's CRITICAL #4: no [id]/page.tsx).
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getAccessToken } from "@/lib/auth";
import { fetchAdminCaseDetail, UNAUTHORIZED, type AdminCaseDetailResponse } from "@/lib/adminCaseDetail";
import { PhotoGallery } from "@/components/admin/PhotoGallery";
import { AIResultPanel } from "@/components/admin/AIResultPanel";
import { CompensationPanel } from "@/components/admin/CompensationPanel";
import { AuditTrail } from "@/components/admin/AuditTrail";

interface CaseDetailPanelProps {
  offlineId: string;
}

type LoadState = "loading" | "error" | "ready";

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export function CaseDetailPanel({ offlineId }: CaseDetailPanelProps) {
  const router = useRouter();
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
      <div className="rounded-md border border-border-default bg-surface-raised p-design-4">
        <p className="text-body text-ink-secondary" role="status">
          Loading case…
        </p>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div role="alert" className="space-y-design-2 rounded-md border border-border-default bg-surface-raised p-design-4">
        <p className="text-body text-status-error">Couldn&apos;t load case detail.</p>
        <button
          type="button"
          onClick={() => setReloadNonce((n) => n + 1)}
          className="min-h-touch-target rounded-md border border-forest px-design-4 text-label font-semibold text-forest"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!data) return null;

  const { case: c, ai_result, compensation, audit_trail } = data;
  const hasGps = c.gps_lat != null && c.gps_lng != null;

  return (
    <div className="space-y-design-4">
      <div className="rounded-md border border-border-default bg-surface-raised p-design-4 space-y-design-2">
        <h2 className="text-heading-3 text-ink-primary">{c.canonical_id ?? "—"}</h2>
        <dl className="grid grid-cols-2 gap-design-2 text-body">
          <div>
            <dt className="text-label text-ink-disabled">Channel</dt>
            <dd className="text-ink-primary">{c.submitted_via ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-label text-ink-disabled">Damage Category</dt>
            <dd className="text-ink-primary">{c.damage_category ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-label text-ink-disabled">Submitted</dt>
            <dd className="text-ink-primary">{formatDateTime(c.submitted_at)}</dd>
          </div>
          <div>
            <dt className="text-label text-ink-disabled">Location</dt>
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

      <PhotoGallery />
      <AIResultPanel aiResult={ai_result} />
      <CompensationPanel compensation={compensation} />
      <AuditTrail trail={audit_trail} />
    </div>
  );
}
