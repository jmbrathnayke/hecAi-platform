"use client";
// Officer dashboard & scoped case list (Story 3.7, NFR-3.2/3.4). English-only officer route.
// Fetches GET /api/v1/officer/cases with the officer's Supabase JWT; the backend scopes the list
// to the officer (own cases OR their assigned divisions) and audits the view. PII is never sent.
import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations, useLocale } from "next-intl";
import { getAccessToken } from "@/lib/auth";
import { useOfficerSession } from "@/hooks/useOfficerSession";
import { KNOWN_STATUSES } from "@/lib/status";
import { ModelLoadStatus } from "@/components/ModelLoadStatus";
import { ArrowClockwise, CaretRight, CloudArrowUp, MapPin, Tray } from "@phosphor-icons/react";
import { Skeleton, StatusBadge, touchButtonStyles } from "@/components/admin/ui";
import { OfficerTopBar } from "@/components/OfficerTopBar";

// Reuse the canonical case-status labels (status.statusLabels) rather than duplicating them
// under `officer` — the keys drop the space ("Under Review" -> "UnderReview"), matching the
// citizen status page's own convention.
function statusKey(status: string): string {
  return status.replace(/\s/g, "");
}

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

// Why the load state carries a reason (2026-08-21). Every non-ok response used to collapse into
// a single "error", so a 403 (this account carries no officer role), a 500 (the server cannot
// verify tokens at all) and an unreachable API all rendered the same sentence above the same
// useless Retry button — the real cause was visible only in DevTools. The backend guards already
// return distinguishable codes (auth.py: forbidden / token_expired / server_misconfigured /
// server_error); this page was the thing throwing them away.
type Failure =
  | { reason: "config" }
  | { reason: "no-session" }
  | { reason: "signed-out"; status: number; code: string }
  | { reason: "forbidden"; status: number; code: string }
  | { reason: "server"; status: number; code: string }
  | { reason: "network" }
  | { reason: "unknown"; status: number; code: string };

type LoadState = { kind: "loading" } | { kind: "ready" } | { kind: "failed"; failure: Failure };

/** The backend's `{"error": "..."}` code, or "" when the body is not the shape we expect. */
async function errorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body?.error === "string" ? body.error : "";
  } catch {
    return "";
  }
}

function classifyResponse(status: number, code: string): Failure {
  if (status === 401) return { reason: "signed-out", status, code };
  if (status === 403) return { reason: "forbidden", status, code };
  if (status >= 500) return { reason: "server", status, code };
  return { reason: "unknown", status, code };
}

function failureMessageKey(f: Failure): string {
  switch (f.reason) {
    case "config":
      return "dashboard.error.config";
    case "no-session":
      return "dashboard.error.noSession";
    case "signed-out":
      return "dashboard.error.signedOut";
    case "forbidden":
      return "dashboard.error.forbidden";
    case "server":
      // A JWKS blip also lands here as 500/server_misconfigured — deliberately, so a transient
      // Supabase outage does not sign every officer out (auth.py's PyJWKClientConnectionError
      // branch). That is why "server" stays retryable below.
      return f.code === "server_misconfigured"
        ? "dashboard.error.serverMisconfigured"
        : "dashboard.error.server";
    case "network":
      return "dashboard.error.network";
    default:
      return "dashboard.error.unknown";
  }
}

/** What the officer can actually do about it. Retry is offered only where it can help. */
function failureRecovery(f: Failure): "sign-in" | "retry" | "none" {
  if (f.reason === "no-session" || f.reason === "signed-out") return "sign-in";
  // Retrying cannot mint a role claim, and it cannot write a missing env var either.
  if (f.reason === "forbidden" || f.reason === "config") return "none";
  return "retry";
}

function formatDate(iso: string | null, locale: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(locale);
}

export default function OfficerDashboardPage() {
  const t = useTranslations("officer");
  const tStatus = useTranslations("status");
  const tCategory = useTranslations("myCases.category");
  // The categories the citizen pages already translate; anything else is shown as stored.
  const damageLabel = (cat: string | null) =>
    !cat ? "—" : ["crop", "property", "combined"].includes(cat) ? tCategory(cat) : cat;
  const locale = useLocale();
  const { officer_id, assigned_divisions } = useOfficerSession();
  const [cases, setCases] = useState<OfficerCase[]>([]);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  // Bumped by Retry to force a re-fetch — setState to the same statusFilter would be an
  // Object.is no-op and would NOT re-run the effect, so Retry needs its own changing dep.
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let active = true;
    (async () => {
      setState({ kind: "loading" });

      // Mirrors the guard inside getAccessToken() (lib/auth.ts), which returns null both for
      // "no session" and for "this build has no Supabase keys". Told apart here so a missing
      // env var is never reported as an expired session — that would send someone to a login
      // page which, lacking the same keys, cannot sign them in either.
      if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
        if (active) setState({ kind: "failed", failure: { reason: "config" } });
        return;
      }

      const token = await getAccessToken();
      if (!token) {
        // No session (middleware normally redirects; handle the race defensively).
        if (active) setState({ kind: "failed", failure: { reason: "no-session" } });
        return;
      }

      let res: Response;
      try {
        const qs = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : "";
        res = await fetch(`${API_BASE}/api/v1/officer/cases${qs}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {
        // fetch() rejects only on a transport failure: API down, DNS, CORS, offline. An HTTP
        // error status resolves normally and is classified below — the two are different
        // problems with different fixes, and the old single catch conflated them.
        if (active) setState({ kind: "failed", failure: { reason: "network" } });
        return;
      }

      if (!res.ok) {
        const failure = classifyResponse(res.status, await errorCode(res));
        if (active) setState({ kind: "failed", failure });
        return;
      }

      try {
        const data = (await res.json()) as { cases?: OfficerCase[] };
        if (active) {
          setCases(data.cases ?? []);
          setState({ kind: "ready" });
        }
      } catch {
        // 200 with a body that is not the JSON we asked for — a proxy or captive portal.
        if (active) {
          setState({
            kind: "failed",
            failure: { reason: "unknown", status: res.status, code: "bad_response" },
          });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [statusFilter, reloadNonce]);

  return (
    // Redesign (2026-10-07): the staff portals' look at field-app sizes. The language switch moved
    // into the app bar and this device's notification switch onto the Profile tab, so the screen
    // opens on the officer's cases: one list, one row per case, the whole row tappable.
    <main className="flex-1 bg-surface-base">
      <OfficerTopBar
        label={t("dashboard.title")}
        action={
          <Link href="/officer/sync" className={`${touchButtonStyles.quiet} shrink-0`}>
            <CloudArrowUp aria-hidden="true" size={18} />
            {t("dashboard.syncQueueLink")}
          </Link>
        }
      />

      <div className="mx-auto max-w-2xl space-y-design-4 px-design-4 py-design-5">
        {officer_id && (
          <p className="inline-flex items-center gap-design-1 text-label text-ink-secondary">
            <MapPin aria-hidden="true" size={16} />
            {assigned_divisions.length > 0
              ? t("dashboard.divisions", { list: assigned_divisions.join(", ") })
              : t("dashboard.noDivisions")}
          </p>
        )}

        <ModelLoadStatus />

        <section className="space-y-design-3">
          <div className="flex items-baseline justify-between gap-design-3">
            <h2 className="text-headline text-ink-primary">{t("dashboard.yourCases")}</h2>
            {state.kind === "ready" && (
              <span className="text-caption tabular-nums text-ink-secondary">{cases.length}</span>
            )}
          </div>

          {/* One scrollable segmented control instead of chips that wrapped onto three lines. */}
          <div
            className="-mx-design-4 overflow-x-auto px-design-4 [scrollbar-width:none]"
            role="group"
            aria-label={t("dashboard.filterGroupLabel")}
          >
            <div className="inline-flex gap-0.5 rounded-sm border border-border-subtle bg-surface-raised p-0.5 shadow-card">
              <FilterChip
                label={t("dashboard.filterAll")}
                active={statusFilter === null}
                onClick={() => setStatusFilter(null)}
              />
              {KNOWN_STATUSES.map((s) => (
                <FilterChip
                  key={s}
                  label={tStatus(`statusLabels.${statusKey(s)}`)}
                  active={statusFilter === s}
                  onClick={() => setStatusFilter(s)}
                />
              ))}
            </div>
          </div>

          {state.kind === "loading" && (
            <div className="overflow-hidden rounded-md border border-border-subtle bg-surface-raised shadow-card">
              <p className="border-b border-border-subtle px-design-4 py-design-3 text-caption text-ink-secondary" role="status">
                {t("dashboard.loading")}
              </p>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="border-b border-border-subtle px-design-4 py-design-4 last:border-b-0">
                  <Skeleton className="h-4 w-36" />
                  <Skeleton className="mt-design-2 h-3 w-48" />
                </div>
              ))}
            </div>
          )}

          {state.kind === "failed" && (
            <div role="alert" className="space-y-design-3 rounded-md border border-status-error/30 bg-status-error-pale p-design-4">
              <p className="text-body text-status-error">{t(failureMessageKey(state.failure))}</p>

              {/* The line that was missing: the HTTP status and the backend's own error code.
                  An officer can ignore it; it is the first thing anyone debugging needs, and
                  it is what previously required opening DevTools to see. */}
              {"status" in state.failure && (
                <p className="font-staff-mono text-caption text-ink-secondary">
                  {t("dashboard.error.detail", {
                    status: state.failure.status,
                    code: state.failure.code || "—",
                  })}
                </p>
              )}

              {failureRecovery(state.failure) === "retry" && (
                <button type="button" onClick={() => setReloadNonce((n) => n + 1)} className={touchButtonStyles.secondary}>
                  <ArrowClockwise aria-hidden="true" size={18} />
                  {t("dashboard.retry")}
                </button>
              )}

              {failureRecovery(state.failure) === "sign-in" && (
                <Link href="/officer/login" className={touchButtonStyles.secondary}>
                  {t("dashboard.error.signIn")}
                </Link>
              )}
            </div>
          )}

          {state.kind === "ready" && cases.length === 0 && (
            <div className="flex flex-col items-center gap-design-3 rounded-md border border-border-subtle bg-surface-raised px-design-5 py-design-7 text-center shadow-card">
              <span className="flex h-12 w-12 items-center justify-center rounded-md bg-surface-tint text-forest">
                <Tray aria-hidden="true" size={24} />
              </span>
              <p className="text-body text-ink-primary">{t("dashboard.empty")}</p>
            </div>
          )}

          {state.kind === "ready" && cases.length > 0 && (
            <ul className="divide-y divide-border-subtle overflow-hidden rounded-md border border-border-subtle bg-surface-raised shadow-card">
              {cases.map((c) => {
                const statusLabel = KNOWN_STATUSES.includes(c.status as (typeof KNOWN_STATUSES)[number])
                  ? tStatus(`statusLabels.${statusKey(c.status)}`)
                  : c.status;
                const body = (
                  <>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-design-2">
                        <span className="font-staff-mono text-label font-semibold text-ink-primary">
                          {c.canonical_id ?? t("dashboard.pendingId")}
                        </span>
                        <StatusBadge status={c.status} label={statusLabel} />
                      </div>
                      <p className="mt-design-1 flex flex-wrap gap-x-design-3 gap-y-design-1 text-caption text-ink-secondary">
                        <span>{damageLabel(c.damage_category)}</span>
                        <span>{t("dashboard.via", { channel: c.submitted_via ?? "app" })}</span>
                        <span className="tabular-nums">{formatDate(c.submitted_at, locale)}</span>
                      </p>
                    </div>
                    {c.canonical_id && <CaretRight aria-hidden="true" size={18} className="shrink-0 text-ink-secondary" />}
                  </>
                );
                return (
                  <li key={c.offline_id ?? c.canonical_id}>
                    {/* The review page is where a "new report" notification lands; the list reaches
                        the same page so an officer who dismissed the notification is not stuck. The
                        whole row is the link, so it is a large target. */}
                    {c.canonical_id ? (
                      <Link
                        href={`/officer/cases/${encodeURIComponent(c.canonical_id)}`}
                        className="flex min-h-[4.5rem] items-center gap-design-3 px-design-4 py-design-3 transition-colors duration-150 hover:bg-surface-base focus-visible:bg-surface-tint focus-visible:outline-none active:bg-surface-tint motion-reduce:transition-none"
                      >
                        {body}
                        <span className="sr-only">{t("dashboard.openCase")}</span>
                      </Link>
                    ) : (
                      <div className="flex min-h-[4.5rem] items-center gap-design-3 px-design-4 py-design-3">{body}</div>
                    )}
                  </li>
                );
              })}
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
      // 44px tall: a segment of one control rather than a free-standing button, and still well
      // above WCAG 2.2's 24px. ink-on-dark on forest is 6.4:1, read in sunlight.
      className={`min-h-[44px] shrink-0 whitespace-nowrap rounded-[6px] px-design-3 text-label font-medium transition-colors duration-150 motion-reduce:transition-none ${
        active ? "bg-forest text-ink-on-dark" : "text-ink-secondary hover:bg-surface-base hover:text-ink-primary"
      }`}
    >
      {label}
    </button>
  );
}
