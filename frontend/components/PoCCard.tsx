// Printable Proof of Claim card. The large reference text is the human-readable id
// (canonical HEC-YYYY-NNNN once assigned, otherwise the offline UUID); the QR code
// ALWAYS encodes the UUID-v4 offline_id (PRD Addendum A3, CRITICAL #1).
"use client";

import { QRCodeSVG } from "qrcode.react";
import { useTranslations } from "next-intl";
import type { PoCRecord } from "@/lib/poc";

interface PoCCardProps {
  poc: PoCRecord;
  canonicalId: string | null;
}

export function PoCCard({ poc, canonicalId }: PoCCardProps) {
  const t = useTranslations("poc");
  const reference = canonicalId ?? poc.offline_id;
  const timestamp = new Date(poc.timestamp_local).toLocaleString();

  return (
    <section
      aria-label={t("title")}
      className="mx-auto flex w-full max-w-md flex-col items-center gap-design-4 rounded-md border border-border-default bg-surface-raised p-design-6 text-center print:max-w-none print:border-0 print:shadow-none"
    >
      <svg
        viewBox="0 0 24 24"
        className="h-10 w-10 text-forest"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M12 2 3 7v6c0 5 3.8 7.7 9 9 5.2-1.3 9-4 9-9V7l-9-5Zm0 2.2 7 3.9V13c0 3.9-2.8 6-7 7.1C7.8 19 5 16.9 5 13V8.1l7-3.9Z" />
      </svg>

      <h1 className="text-title font-bold text-ink-primary">{t("title")}</h1>

      <div className="flex flex-col gap-design-1">
        <span className="text-caption uppercase tracking-wide text-ink-secondary">
          {t("canonicalLabel")}
        </span>
        <span className="select-all break-all text-headline font-semibold text-ink-primary">
          {reference}
        </span>
      </div>

      <div id="poc-qr" className="rounded-md bg-white p-design-3 print:p-0">
        <QRCodeSVG value={poc.offline_id} size={180} level="M" includeMargin />
      </div>

      <p className="text-caption text-ink-secondary">{timestamp}</p>

      <p className="text-caption text-ink-disabled print:mt-design-4">{t("footer")}</p>
    </section>
  );
}
