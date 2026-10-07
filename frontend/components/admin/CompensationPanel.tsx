"use client";

// Compensation estimate panel (Story 5.4 AC3, NFR-6.1). compensation_estimates has no row
// for many real cases (damage_category "none", or a silently rolled-back estimation
// failure — see the story's Dev Notes § Known Data Coverage), so the empty state below is a
// real, expected path, not an afterthought. Localized si/ta/en (Story 6.3): chrome is
// translated; feature-value keys, model_version and the LKR figures stay raw data.
import { useTranslations } from "next-intl";
import type { AdminCompensation } from "@/lib/adminCaseDetail";

interface CompensationPanelProps {
  compensation: AdminCompensation | null;
}

function formatLkr(amount: number): string {
  return `Rs. ${amount.toLocaleString("en-LK", { maximumFractionDigits: 0 })}`;
}

function formatFeatureKey(key: string): string {
  return key.replace(/_/g, " ");
}

export function CompensationPanel({ compensation }: CompensationPanelProps) {
  const t = useTranslations("admin");

  if (!compensation) {
    return (
      <div className="rounded-md border border-dashed border-border-subtle p-design-4 text-label text-ink-secondary">
        {t("compensation.empty")}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border-subtle bg-surface-raised shadow-card p-design-4 space-y-design-3">
      {/* was `text-heading-3` — undefined token; see AIResultPanel. DESIGN.md § Typography. */}
      <h3 className="text-label font-semibold text-ink-primary">{t("compensation.heading")}</h3>
      <p className="text-label font-semibold text-amber">{t("compensation.aiRecommendation")}</p>
      {/* The estimate is decision support. The administrator recommends an amount; the Divisional
          Secretariat records the final compensation decision. */}
      <p className="text-caption text-ink-secondary" data-testid="compensation-not-final">
        {t("compensation.notFinal")}
      </p>

      <div>
        <p className="text-caption text-ink-secondary">{t("compensation.recommendedAmount")}</p>
        <p className="text-display font-semibold tabular-nums tracking-tight text-ink-primary">{formatLkr(compensation.amount_lkr)}</p>
        {/* Code review fix (AC3/Task 7): always show the yes/no cap status, not just when
            capped -- previously nothing rendered for the common capped=false case, so an
            admin couldn't tell "checked, not capped" from "field not rendered". */}
        {compensation.capped ? (
          <p className="text-caption text-amber">
            {t("compensation.capYes", { amount: formatLkr(compensation.raw_estimate_lkr) })}
          </p>
        ) : (
          <p className="text-caption text-ink-secondary">{t("compensation.capNo")}</p>
        )}
      </div>

      <table className="w-full text-label">
        <thead>
          <tr>
            <th className="text-left text-ink-secondary">{t("compensation.colFeature")}</th>
            <th className="text-right text-ink-secondary">{t("compensation.colValue")}</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(compensation.feature_values).map(([key, value]) => (
            <tr key={key} className="border-t border-border-subtle">
              <td className="py-1.5 capitalize text-ink-secondary">{formatFeatureKey(key)}</td>
              <td className="py-1.5 text-right tabular-nums text-ink-primary">{String(value ?? "—")}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="text-caption text-ink-disabled">
        {compensation.model_version}
        {compensation.dataset_version ? ` · ${compensation.dataset_version}` : ""}
      </p>
    </div>
  );
}
