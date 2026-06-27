"use client";
// Step 2 of the incident form: incident location.
// Auto-acquires GPS (10s timeout); on failure shows a manual map-pin picker (FR-1.6).
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useRouter } from "@/navigation";
import { StepIndicator } from "@/components/StepIndicator";
import { getCurrentPosition } from "@/lib/geolocation";
import { getCase, putCase } from "@/lib/indexeddb";
import type { LatLng } from "@/components/MapPinPicker";

// Leaflet touches `window`; load the picker client-side only.
const MapPinPicker = dynamic(() => import("@/components/MapPinPicker"), { ssr: false });

const DRAFT_ID_KEY = "hec-draft-id";
const SRI_LANKA_CENTER: LatLng = { lat: 7.8731, lng: 80.7718 };

type Status = "detecting" | "gps" | "manual";

export default function LocationStep() {
  const t = useTranslations("report");
  const router = useRouter();
  const steps = [t("steps.identity"), t("steps.location"), t("steps.damage"), t("steps.photos")];

  const [status, setStatus] = useState<Status>("detecting");
  const [coords, setCoords] = useState<LatLng | null>(null);
  const [saving, setSaving] = useState(false);
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return; // guard against React 18 StrictMode double-invoke
    ranRef.current = true;
    getCurrentPosition()
      .then((c) => {
        setCoords({ lat: c.latitude, lng: c.longitude });
        setStatus("gps");
      })
      .catch(() => setStatus("manual"));
  }, []);

  async function saveAndNext(loc: LatLng, source: "gps" | "manual") {
    if (saving) return;
    setSaving(true);
    try {
      let offlineId = sessionStorage.getItem(DRAFT_ID_KEY);
      if (!offlineId) {
        offlineId = crypto.randomUUID();
        sessionStorage.setItem(DRAFT_ID_KEY, offlineId);
      }
      const existing = (await getCase(offlineId)) ?? {};
      await putCase({
        ...existing,
        offline_id: offlineId,
        location_lat: loc.lat,
        location_lng: loc.lng,
        location_source: source,
        sync_status: "draft",
        updated_at: new Date().toISOString(),
      });
      router.push("/report/damage");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-design-6 px-design-5 py-design-6">
      <StepIndicator steps={steps} currentStep={1} />

      <header>
        <h1 className="text-title font-bold text-ink-primary">{t("step2.title")}</h1>
      </header>

      {status === "detecting" && (
        <div className="flex flex-col items-center gap-design-3 py-design-7" role="status" aria-live="polite">
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-border-default border-t-forest" aria-hidden="true" />
          <p className="text-body text-ink-secondary">{t("step2.detecting")}</p>
        </div>
      )}

      {status === "gps" && coords && (
        <div className="flex flex-col gap-design-4">
          <div className="rounded-md border border-status-success bg-surface-tint p-design-4">
            <p className="text-label font-semibold text-status-success">{t("step2.gpsDetected")}</p>
            <p className="text-body text-ink-primary">
              {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}
            </p>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={() => void saveAndNext(coords, "gps")}
            className="flex min-h-primary-btn items-center justify-center rounded-md bg-amber px-design-5 text-headline font-semibold text-ink-on-amber transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {t("step2.next")}
          </button>
        </div>
      )}

      {status === "manual" && (
        <div className="flex flex-col gap-design-3">
          <p className="text-body text-ink-secondary">{t("step2.gpsFailed")}</p>
          <MapPinPicker
            initial={coords ?? SRI_LANKA_CENTER}
            confirmLabel={t("step2.confirmPin")}
            onConfirm={(c) => void saveAndNext(c, "manual")}
          />
        </div>
      )}
    </main>
  );
}
