"use client";
// Whether the family's photographs have actually reached the DWC (lib/citizenPhotoOutbox.ts).
//
// WHY THIS EXISTS. Photographs upload in a second pass after the report is stored, and that pass
// used to run only from the background runner: at page load, when the tab regained focus, or once a
// minute. A family that submitted, saw the receipt and closed the app (or handed the phone to an
// officer who signed in) left their photographs on the phone, and the officer opening the case saw
// none. The receipt now sends them at once, and says plainly whether they arrived, so "sent" is
// something the family can see rather than assume.
//
// READS THIS PHONE'S OWN OUTBOX RECORD. A report filed on another device has no record here, and
// then nothing is shown: this phone cannot know what another phone sent.
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { getCase } from "@/lib/indexeddb";
import { flushCitizenPhotos, photoDelivery, type PhotoDelivery } from "@/lib/citizenPhotoOutbox";
import type { OutboxRecord } from "@/lib/citizenOutbox";

type Props = {
  /** The report's offline id: the key of its record in this phone's outbox. */
  offlineId: string;
  /** Set once the server has the report. Photographs can only attach to a stored case. */
  canonicalId: string | null;
  /** Send as soon as the case exists (the receipt). Lists pass false and offer "Send now". */
  autoSend?: boolean;
};

// The background runner may be mid-flush when we ask; wait for it rather than report "waiting".
const IN_FLIGHT_RETRY_MS = 1500;
const IN_FLIGHT_MAX_RETRIES = 8;

export function PhotoDeliveryStatus({ offlineId, canonicalId, autoSend = true }: Props) {
  const t = useTranslations("poc");
  const [delivery, setDelivery] = useState<PhotoDelivery | null>(null);
  const [sending, setSending] = useState(false);
  const mounted = useRef(true);
  const autoSent = useRef(false);

  const refresh = useCallback(async () => {
    const record = (await getCase(offlineId).catch(() => null)) as OutboxRecord | null;
    if (mounted.current) setDelivery(record ? photoDelivery(record) : null);
  }, [offlineId]);

  const send = useCallback(
    async (force: boolean) => {
      setSending(true);
      try {
        for (let attempt = 0; attempt <= IN_FLIGHT_MAX_RETRIES; attempt += 1) {
          const res = await flushCitizenPhotos(Date.now(), { force }).catch(() => null);
          if (res?.skipped !== "in-flight") break;
          await new Promise((r) => setTimeout(r, IN_FLIGHT_RETRY_MS));
          if (!mounted.current) return;
        }
      } finally {
        if (mounted.current) setSending(false);
        await refresh();
      }
    },
    [refresh],
  );

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (!canonicalId || !autoSend || autoSent.current) return;
    autoSent.current = true;
    void send(false);
  }, [canonicalId, autoSend, send]);

  // Coming back online is when waiting photographs can finally go.
  useEffect(() => {
    if (!canonicalId) return;
    const onOnline = () => void send(false);
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [canonicalId, send]);

  if (!delivery || delivery.total === 0) return null;

  const online = typeof navigator === "undefined" || navigator.onLine !== false;
  const allSent = delivery.uploaded === delivery.total;

  let tone = "bg-forest-pale text-forest";
  let message: string;
  if (!canonicalId) {
    message = t("photosBeforeCase", { count: delivery.total });
  } else if (sending) {
    message = t("photosSending", { done: delivery.uploaded, total: delivery.total });
  } else if (allSent) {
    message = t("photosSent", { count: delivery.total });
  } else if (delivery.pending > 0) {
    tone = "bg-amber-pale text-amber";
    message = t("photosWaiting", { count: delivery.pending });
  } else {
    tone = "bg-amber-pale text-amber";
    message = t("photosPartial", { done: delivery.uploaded, total: delivery.total });
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="photo-delivery"
      className={`rounded-md px-design-3 py-design-2 text-caption leading-relaxed print:hidden ${tone}`}
    >
      <p>{message}</p>
      {delivery.rejected > 0 && canonicalId && (
        <p className="mt-design-1" data-testid="photo-delivery-rejected">
          {t("photosRejected", { count: delivery.rejected })}
        </p>
      )}
      {canonicalId && !sending && delivery.pending > 0 && online && (
        <button
          type="button"
          onClick={() => void send(true)}
          className="mt-design-2 min-h-touch-target rounded-md border border-current px-design-3 text-label font-semibold"
          data-testid="photo-delivery-send"
        >
          {t("photosSendNow")}
        </button>
      )}
    </div>
  );
}
