"use client";

// Compensation caps settings (Story 5.6, FR-4.4). Role-gate mirrors admin/cases/page.tsx's
// exact pattern (getUser() re-verification + signOut()-on-non-admin) -- there is no separate
// "System Admin" role in this codebase's as-built RBAC (see backend admin.py's Dev Notes
// CRITICAL #2), so this is the same require_admin()-gated route every other admin page uses.
//
// One editable column (property damage cap), not a Crop/Property/Combined grid: the RF model's
// _DAMAGE_TYPE_MAP collapses every damage category onto a single "property" bucket, so a cap
// saved under any other value would never be read by a real estimate.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase";
import { getAccessToken } from "@/lib/auth";
import {
  fetchCompensationCaps,
  updateCompensationCap,
  UNAUTHORIZED,
  type CompensationCap,
} from "@/lib/adminSettings";
import districtReference from "@/public/data/district_reference.json";
import { PageHeader, Skeleton, buttonStyles, fieldStyles } from "@/components/admin/ui";

// Same district vocabulary DistrictPicker.tsx uses (Story 5.2) -- imported directly rather
// than the whole cascading two-level component, since caps have no DS-division granularity.
const ALL_DISTRICTS = Object.keys(districtReference as Record<string, string[]>).sort();

type LoadState = "loading" | "error" | "ready";

export default function CompensationCapsPage() {
  const router = useRouter();
  const t = useTranslations("admin");

  // --- Role gate (mirrors admin/cases/page.tsx) ----------------------------------------
  const [checked, setChecked] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const supabase = createClient();

    (async () => {
      let isAdmin = false;
      try {
        const { data, error } = await supabase.auth.getUser();
        isAdmin = !error && data.user?.app_metadata?.role === "admin";
      } catch {
        isAdmin = false;
      }
      if (!mountedRef.current) return;

      if (!isAdmin) {
        try {
          await supabase.auth.signOut();
        } catch {
          // Even if sign-out fails, we still refuse entry below.
        }
        if (mountedRef.current) router.replace("/admin/login");
        return;
      }
      setChecked(true);
    })();

    return () => {
      mountedRef.current = false;
    };
  }, [router]);

  // --- Caps (Story 5.6) -----------------------------------------------------------------
  const [caps, setCaps] = useState<CompensationCap[] | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  // Set, not a single district (code review, Story 5.6): a single string meant starting a second
  // district's save re-enabled the first district's still-in-flight Save button, allowing a
  // duplicate concurrent PUT for it.
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!checked) return;
    let active = true;
    (async () => {
      setState("loading");
      const token = await getAccessToken();
      if (!token) {
        if (active) setState("error");
        return;
      }
      const result = await fetchCompensationCaps(token);
      if (!active) return;
      if (result === UNAUTHORIZED) {
        router.replace("/admin/login");
        return;
      }
      if (!result) {
        setState("error");
        return;
      }
      setCaps(result);
      setState("ready");
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked]);

  function capFor(district: string): CompensationCap | undefined {
    return caps?.find((c) => c.district === district);
  }

  async function handleSave(district: string) {
    const raw = amounts[district];
    const amount = Number(raw);
    if (raw === undefined || raw === "" || Number.isNaN(amount) || amount < 0) return;

    setSaving((prev) => new Set(prev).add(district));
    setError(null);

    const token = await getAccessToken();
    if (!token) {
      router.replace("/admin/login");
      return;
    }

    const result = await updateCompensationCap(token, district, amount);
    setSaving((prev) => {
      const next = new Set(prev);
      next.delete(district);
      return next;
    });
    if (result === UNAUTHORIZED) {
      router.replace("/admin/login");
      return;
    }
    if (!result) {
      setError(t("caps.saveError"));
      return;
    }
    setCaps((prev) => [...(prev ?? []).filter((c) => c.district !== district), result]);
    // Only clear the pending edit if it still equals what was just saved (code review, Story
    // 5.6) -- unconditionally deleting it discarded a newer edit typed while this save was
    // still in flight, silently reverting the input to the just-saved value.
    setAmounts((prev) => {
      if (prev[district] !== raw) return prev;
      const next = { ...prev };
      delete next[district];
      return next;
    });
  }

  if (!checked) return null;

  // Redesign (2026-10-07): the same page header and raised surface as the rest of the admin
  // area. Each row is still a <tr> with its own input and Save button; one district saves at a time.
  return (
    <main className="min-h-full bg-surface-base px-design-4 py-design-5 sm:px-design-5 lg:py-design-6">
      <div className="mx-auto max-w-4xl space-y-design-5">
        <PageHeader title={t("caps.title")} subtitle={<span className="block max-w-[65ch]">{t("caps.intro")}</span>} />

        {state === "loading" && (
          <div className="rounded-md border border-border-subtle bg-surface-raised p-design-4 shadow-card">
            <p className="text-caption text-ink-secondary" role="status">
              {t("caps.loading")}
            </p>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="mt-design-3 flex items-center gap-design-4">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-9 flex-1" />
                <Skeleton className="h-9 w-20" />
              </div>
            ))}
          </div>
        )}

        {state === "error" && (
          <p role="alert" className="rounded-md border border-status-error/30 bg-status-error-pale px-design-4 py-design-3 text-label text-status-error">
            {t("caps.loadError")}
          </p>
        )}

        {error && (
          <p role="alert" className="rounded-md border border-status-error/30 bg-status-error-pale px-design-4 py-design-3 text-label text-status-error">
            {error}
          </p>
        )}

        {state === "ready" && (
          <div className="overflow-x-auto rounded-md border border-border-subtle bg-surface-raised shadow-card">
            <table className="w-full min-w-[480px] border-collapse text-label">
              <thead>
                <tr className="border-b border-border-subtle bg-surface-base text-left text-caption font-medium text-ink-secondary">
                  <th scope="col" className="px-design-4 py-design-3 font-medium">{t("caps.colDistrict")}</th>
                  <th scope="col" className="px-design-4 py-design-3 font-medium">{t("caps.colCap")}</th>
                  <th scope="col" className="px-design-4 py-design-3" />
                </tr>
              </thead>
              <tbody>
                {ALL_DISTRICTS.map((district) => {
                  const existing = capFor(district);
                  const value =
                    amounts[district] ?? (existing ? String(existing.cap_amount_lkr) : "");
                  return (
                    <tr key={district} className="border-b border-border-subtle last:border-b-0">
                      <td className="whitespace-nowrap px-design-4 py-design-3 font-medium text-ink-primary">{district}</td>
                      <td className="px-design-4 py-design-3">
                        <input
                          type="number"
                          min={0}
                          aria-label={t("caps.capAria", { district })}
                          value={value}
                          onChange={(e) =>
                            setAmounts((prev) => ({ ...prev, [district]: e.target.value }))
                          }
                          placeholder={existing ? undefined : t("caps.noCapPlaceholder")}
                          className={`${fieldStyles} tabular-nums placeholder:text-ink-secondary`}
                        />
                      </td>
                      <td className="px-design-4 py-design-3 text-right">
                        <button
                          type="button"
                          disabled={saving.has(district)}
                          onClick={() => handleSave(district)}
                          className={buttonStyles.secondary}
                        >
                          {saving.has(district) ? t("caps.saving") : t("caps.save")}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
