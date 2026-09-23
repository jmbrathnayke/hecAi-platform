// Printable Proof of Claim card. The large reference text is the human-readable id
// (canonical HEC-YYYY-NNNN once assigned, otherwise the offline UUID); the QR code
// ALWAYS encodes the UUID-v4 offline_id (PRD Addendum A3, CRITICAL #1).
//
// Composed to match proof-of-claim.html: a forest card with white text carrying the reference
// number, labelled detail rows, and the QR inline beside its hint copy.
//
// Mockup parity note: the mockup's fourth detail row is a masked NIC ("78****321V"). It is NOT
// rendered here and cannot be — the client only ever holds `submitter_identity_hash` (a SHA-256
// of offline_id:nicCiphertext, see lib/poc.ts computeIdentityHash). There is no plaintext NIC on
// this device to mask, and reconstructing one would defeat the point of the hash.
"use client";

import { QRCodeSVG } from "qrcode.react";
import { useTranslations } from "next-intl";
import { DAMAGE_CATEGORY_KEYS } from "@/components/admin/damageVocabulary";
import type { PoCRecord } from "@/lib/poc";

interface PoCCardProps {
  poc: PoCRecord;
  canonicalId: string | null;
  /** The server may still return the HEC number: say so instead of showing the offline UUID. */
  awaitingReference?: boolean;
}

// `ai_severity` is a free-form string on PoCRecord; guard it the same way the admin components
// guard status/damage values so an unexpected value falls back instead of rendering next-intl's
// missing-message placeholder.
const SEVERITY_VALUES = new Set(["None", "Minor", "Moderate", "Severe"]);

export function PoCCard({ poc, canonicalId, awaitingReference = false }: PoCCardProps) {
  const t = useTranslations("poc");
  const tReport = useTranslations("report");
  // The citizen layout loads the whole locale bundle via getMessages(), so the officer
  // namespace's severity labels are available here — they are the single source of truth for
  // severity display text and are not worth duplicating into `poc`.
  const tOfficer = useTranslations("officer");

  const reference = canonicalId ?? poc.offline_id;
  const timestamp = new Date(poc.timestamp_local).toLocaleString();

  // Location: prefer the picked district/DS division, fall back to raw GPS, then "not recorded".
  const location =
    [poc.district, poc.ds_division].filter(Boolean).join(", ") ||
    (poc.gps ? `${poc.gps.lat.toFixed(4)}, ${poc.gps.lng.toFixed(4)}` : t("notRecorded"));

  // Damage type: same missing-message guard the admin tables use — fall back to the raw value
  // for anything outside the canonical report.step3 keys rather than rendering a placeholder.
  const category = poc.damage_category;
  const damageLabel = category
    ? DAMAGE_CATEGORY_KEYS.has(category)
      ? tReport(`step3.${category}`)
      : category
    : t("notRecorded");
  const severityLabel =
    poc.ai_severity && SEVERITY_VALUES.has(poc.ai_severity)
      ? tOfficer(`severity.${poc.ai_severity}`)
      : null;
  const damageValue = severityLabel ? `${damageLabel} — ${severityLabel}` : damageLabel;

  return (
    <section
      aria-label={t("title")}
      className="mx-auto w-full max-w-md overflow-hidden rounded-lg bg-forest p-design-5 text-ink-on-dark print:rounded-none print:border print:border-border-default"
    >
      {/* Brand line */}
      <div className="flex items-center gap-design-2">
        <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" fill="currentColor" aria-hidden="true">
          <path d="M12 2 3 7v6c0 5 3.8 7.7 9 9 5.2-1.3 9-4 9-9V7l-9-5Zm0 2.2 7 3.9V13c0 3.9-2.8 6-7 7.1C7.8 19 5 16.9 5 13V8.1l7-3.9Z" />
        </svg>
        <p className="text-caption leading-tight opacity-80">
          {t("brand")}
          <br />
          {t("title")}
        </p>
      </div>

      {/* Reference number */}
      <p className="mt-design-4 text-caption uppercase tracking-wide opacity-70">
        {canonicalId || awaitingReference ? t("canonicalLabel") : t("temporaryLabel")}
      </p>
      {awaitingReference ? (
        <p role="status" className="text-title font-bold tracking-wide opacity-80">
          {t("assigningRef")}
        </p>
      ) : (
        // break-all: an unsynced receipt shows a 36-char UUID here, which must wrap inside the
        // card rather than overflow it on a 360px screen.
        <p className="select-all break-all text-title font-bold tracking-wide">{reference}</p>
      )}
      {!canonicalId && !awaitingReference && (
        <p className="mt-design-1 text-caption opacity-80">{t("temporaryHint")}</p>
      )}

      {/* Detail rows */}
      <dl className="mt-design-4 flex flex-col divide-y divide-white/20 border-y border-white/20">
        <DetailRow label={t("rowSubmitted")} value={timestamp} />
        <DetailRow label={t("rowLocation")} value={location} />
        <DetailRow label={t("rowDamageType")} value={damageValue} />
      </dl>

      {/* QR + hint. The QR keeps a white tile behind it — a green background would break
          scanner contrast. */}
      <div className="mt-design-4 flex items-center gap-design-4">
        {/* includeMargin stays ON: the 4-module quiet zone is part of the QR spec and is what
            the PNG export (downloadPoCPng) rasterises, so dropping it would hurt scan
            reliability on the exported receipt, not just on screen. */}
        <div id="poc-qr" className="shrink-0 rounded-sm bg-white p-design-1">
          <QRCodeSVG value={poc.offline_id} size={104} level="M" includeMargin />
        </div>
        <p className="text-caption leading-relaxed opacity-75">{t("qrHint")}</p>
      </div>

      <p className="mt-design-3 text-center text-caption opacity-60 print:hidden">
        {t("screenshotHint")}
      </p>
    </section>
  );
}

/**
 * One label/value row. The value is right-aligned and width-capped (mockup), and `break-words`
 * keeps a long DS-division name inside the card instead of forcing horizontal overflow.
 */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-design-3 py-design-2">
      <dt className="shrink-0 text-caption uppercase tracking-wide opacity-70">{label}</dt>
      <dd className="max-w-[60%] break-words text-right text-caption font-semibold">{value}</dd>
    </div>
  );
}
