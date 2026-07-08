"use client";
// Citizen "My Cases" (Story 4.0). Localized, session-protected (middleware). Lists the cases the
// signed-in citizen owns via GET /api/v1/citizen/cases (scoped + PII-free by the backend).
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { getAccessToken } from "@/lib/auth";
import { createClient } from "@/lib/supabase";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

interface CitizenCase {
  canonical_id: string | null;
  offline_id: string | null;
  status: string;
  damage_category: string | null;
  submitted_via: string | null;
  submitted_at: string | null;
  updated_at: string | null;
}

type LoadState = "loading" | "error" | "ready";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

export default function MyCasesPage() {
  const t = useTranslations("myCases");
  const locale = useLocale();
  const router = useRouter();
  const [cases, setCases] = useState<CitizenCase[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  // Bumped by Retry to force a re-fetch (a same-value setState would be an Object.is no-op and
  // would NOT re-run the effect — Story 3.7 lesson).
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
        const res = await fetch(`${API_BASE}/api/v1/citizen/cases`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          if (active) setState("error");
          return;
        }
        const data = (await res.json()) as { cases?: CitizenCase[] };
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
  }, [reloadNonce]);

  async function handleSignOut() {
    try {
      await createClient().auth.signOut();
    } catch {
      // Best-effort; navigate away regardless.
    }
    router.push(`/${locale}/login`);
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-design-4 bg-surface-base px-design-5 py-design-6">
      <header className="flex items-center justify-between">
        <h1 className="text-title font-bold text-ink-primary">{t("title")}</h1>
        <button
          type="button"
          onClick={handleSignOut}
          className="min-h-touch-target rounded-md border border-border-default px-design-3 text-caption font-medium text-ink-secondary"
        >
          {t("signOut")}
        </button>
      </header>

      {state === "loading" && (
        <p role="status" className="text-body text-ink-secondary">
          {t("loading")}
        </p>
      )}

      {state === "error" && (
        <div role="alert" className="flex flex-col gap-design-2">
          <p className="text-body text-status-error">{t("error")}</p>
          <button
            type="button"
            onClick={() => setReloadNonce((n) => n + 1)}
            className="min-h-touch-target self-start rounded-md border border-forest px-design-4 text-label font-semibold text-forest"
          >
            {t("retry")}
          </button>
        </div>
      )}

      {state === "ready" && cases.length === 0 && (
        <p className="text-body text-ink-secondary">{t("empty")}</p>
      )}

      {state === "ready" && cases.length > 0 && (
        <ul className="flex flex-col gap-design-2">
          {cases.map((c) => (
            <li
              key={c.offline_id ?? c.canonical_id}
              className="rounded-md border border-border-default bg-surface-raised px-design-3 py-design-3"
            >
              <div className="flex items-center justify-between gap-design-2">
                <span className="text-label font-semibold text-ink-primary">
                  {c.canonical_id ?? "…"}
                </span>
                <span className="rounded-full bg-surface-base px-design-2 text-caption font-medium text-ink-secondary">
                  {c.status}
                </span>
              </div>
              <dl className="mt-design-1 flex flex-wrap gap-x-design-4 gap-y-design-1 text-caption text-ink-secondary">
                <span>{c.damage_category ?? "—"}</span>
                <span>{formatDate(c.submitted_at)}</span>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
