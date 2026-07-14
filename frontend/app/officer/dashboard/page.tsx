"use client";
// Officer dashboard & scoped case list (Story 3.7, NFR-3.2/3.4). English-only officer route.
// Fetches GET /api/v1/officer/cases with the officer's Supabase JWT; the backend scopes the list
// to the officer (own cases OR their assigned divisions) and audits the view. PII is never sent.
import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { getAccessToken } from "@/lib/auth";
import { useOfficerSession } from "@/hooks/useOfficerSession";
import { KNOWN_STATUSES } from "@/lib/status";
import { ModelLoadStatus } from "@/components/ModelLoadStatus";
import { LanguageSelectorCookie } from "@/components/LanguageSelectorCookie";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

interface OfficerCase {
  canonical_id: string | null;
  offline_id: string | null;
  status: string;
  damage_category: string | null;
  submitted_via: string | null;
  gps_lat: number | null;
  gps_lng: number | null;
  submitted_at: string | null;
  updated_at: string | null;
}

type LoadState = "loading" | "error" | "ready";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

export default function OfficerDashboardPage() {
  const t = useTranslations("officer");
  const { officer_id, assigned_divisions } = useOfficerSession();
  const [cases, setCases] = useState<OfficerCase[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  // Bumped by Retry to force a re-fetch — setState to the same statusFilter would be an
  // Object.is no-op and would NOT re-run the effect, so Retry needs its own changing dep.
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let active = true;
    (async () => {
      setState("loading");
      const token = await getAccessToken();
      if (!token) {
        // No session (middleware normally redirects; handle the race defensively).
        if (active) setState("error");
        return;
      }
      try {
        const qs = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : "";
        const res = await fetch(`${API_BASE}/api/v1/officer/cases${qs}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          if (active) setState("error");
          return;
        }
        const data = (await res.json()) as { cases?: OfficerCase[] };
        if (active) {
          setCases(data.cases ?? []);
          setState("ready");
        }
      } catch {
        if (active) setState("error");
      }
    })();
    return () => {
      active = false;
    };
  }, [statusFilter, reloadNonce]);

  return (
    <main className="min-h-screen bg-surface-base px-design-4 py-design-6">
      <div className="mx-auto max-w-2xl space-y-design-4">
        <header className="space-y-design-1">
          <div className="flex items-center justify-between gap-design-2">
            <h1 className="text-title text-ink-primary">Officer Portal</h1>
            <Link href="/officer/sync" className="text-label font-semibold text-forest">
              Sync Queue
            </Link>
          </div>
          {officer_id && (
            <p className="text-caption text-ink-secondary">
              {assigned_divisions.length > 0
                ? `Divisions: ${assigned_divisions.join(", ")}`
                : "No divisions assigned"}
            </p>
          )}
          <div className="flex flex-col gap-design-1 pt-design-2">
            <span className="text-caption text-ink-secondary">{t("languageLabel")}</span>
            <LanguageSelectorCookie />
          </div>
        </header>

        <ModelLoadStatus />

        <section className="space-y-design-3">
          <h2 className="text-heading text-ink-primary">Your cases</h2>

          {/* Status filter chips */}
          <div className="flex flex-wrap gap-design-2" role="group" aria-label="Filter by status">
            <FilterChip
              label="All"
              active={statusFilter === null}
              onClick={() => setStatusFilter(null)}
            />
            {KNOWN_STATUSES.map((s) => (
              <FilterChip
                key={s}
                label={s}
                active={statusFilter === s}
                onClick={() => setStatusFilter(s)}
              />
            ))}
          </div>

          {state === "loading" && (
            <p className="text-body text-ink-secondary" role="status">
              Loading your cases…
            </p>
          )}

          {state === "error" && (
            <div role="alert" className="space-y-design-2">
              <p className="text-body text-status-error">Couldn&apos;t load your cases.</p>
              <button
                type="button"
                onClick={() => setReloadNonce((n) => n + 1)}
                className="min-h-touch-target rounded-md border border-forest px-design-4 text-label font-semibold text-forest"
              >
                Retry
              </button>
            </div>
          )}

          {state === "ready" && cases.length === 0 && (
            <p className="text-body text-ink-secondary">No cases in your scope yet.</p>
          )}

          {state === "ready" && cases.length > 0 && (
            <ul className="space-y-design-2">
              {cases.map((c) => (
                <li
                  key={c.offline_id ?? c.canonical_id}
                  className="rounded-md border border-border-default bg-surface-raised px-design-3 py-design-3"
                >
                  <div className="flex items-center justify-between gap-design-2">
                    <span className="text-label font-semibold text-ink-primary">
                      {c.canonical_id ?? "(pending id)"}
                    </span>
                    <StatusBadge status={c.status} />
                  </div>
                  <dl className="mt-design-1 flex flex-wrap gap-x-design-4 gap-y-design-1 text-caption text-ink-secondary">
                    <span>{c.damage_category ?? "—"}</span>
                    <span>via {c.submitted_via ?? "app"}</span>
                    <span>{formatDate(c.submitted_at)}</span>
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`min-h-touch-target rounded-full px-design-3 text-caption font-medium ${
        active
          ? "bg-forest text-ink-on-forest"
          : "border border-border-default text-ink-secondary"
      }`}
    >
      {label}
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className="rounded-full bg-surface-base px-design-2 text-caption font-medium text-ink-secondary">
      {status}
    </span>
  );
}
