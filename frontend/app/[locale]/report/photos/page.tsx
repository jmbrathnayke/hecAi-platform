"use client";
// Step 4 of the incident form: capture 1–10 damage photos with on-capture quality
// feedback. Blobs live in the photo_blobs store; the draft holds only blob_key refs,
// kept in sync on every add/remove so captured photos survive navigation.
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/navigation";
import { StepIndicator } from "@/components/StepIndicator";
import { PhotoThumbnail } from "@/components/PhotoThumbnail";
import { assessImageQuality } from "@/lib/imageQuality";
import {
  addPhotoBlob,
  deletePhotoBlob,
  getCase,
  listPhotoBlobs,
  updateDraft,
} from "@/lib/indexeddb";
import { getDraftId } from "@/lib/draft";
import { uuidv4 } from "@/lib/uuid";

const MAX_PHOTOS = 10;

interface PhotoEntry {
  blobKey: string;
  previewUrl: string;
  blurry: boolean;
  poorExposure: boolean;
  pending: boolean; // quality check / blob save in flight
}

export default function PhotosStep() {
  const t = useTranslations("report");
  const router = useRouter();
  const steps = [t("steps.identity"), t("steps.location"), t("steps.damage"), t("steps.photos")];

  const fileInputRef = useRef<HTMLInputElement>(null);
  // blob_key of the photo being retaken (null = a plain "add"). Consumed on the
  // next file selection; cleared eagerly so a cancelled picker can't leak it.
  const retakeTargetRef = useRef<string | null>(null);
  const [photos, setPhotos] = useState<PhotoEntry[]>([]);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [restored, setRestored] = useState(false);

  // Keep a ref of preview URLs so the unmount-only cleanup can revoke them all.
  const urlsRef = useRef<string[]>([]);
  urlsRef.current = photos.map((p) => p.previewUrl);
  useEffect(() => {
    return () => {
      urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  // Restore any photos already captured (returning from a later step); redirect to
  // Step 1 if there is no draft. Merges with anything captured before this resolves
  // and clamps to MAX_PHOTOS in case an older/corrupt draft carries more keys.
  useEffect(() => {
    const draftId = getDraftId();
    if (!draftId) {
      router.replace("/report");
      return;
    }
    let active = true;
    getCase(draftId)
      .then(async (draft) => {
        const keys = ((draft?.photo_blob_keys as string[] | undefined) ?? []).slice(0, MAX_PHOTOS);
        if (!active || keys.length === 0) return;
        const blobs = await listPhotoBlobs(keys);
        if (!active) return;
        setPhotos((prev) => {
          const existing = new Set(prev.map((p) => p.blobKey));
          const restoredEntries = blobs
            .filter((b) => !existing.has(b.blob_key))
            .map((b) => ({
              blobKey: b.blob_key,
              previewUrl: URL.createObjectURL(b.blob),
              blurry: false,
              poorExposure: false,
              pending: false,
            }));
          return [...restoredEntries, ...prev].slice(0, MAX_PHOTOS);
        });
      })
      .catch(() => {})
      .finally(() => {
        if (active) setRestored(true);
      });
    return () => {
      active = false;
    };
  }, [router]);

  // Persist the draft's photo_blob_keys whenever the committed photo set changes, so
  // captured photos survive a navigate-back and removed photos never leave dangling
  // keys. Gated on `restored` so we don't overwrite the draft with [] before the
  // initial restore has loaded. Pending entries are excluded (their blob isn't saved
  // yet).
  useEffect(() => {
    if (!restored) return;
    const draftId = getDraftId();
    if (!draftId) return;
    const keys = photos.filter((p) => !p.pending).map((p) => p.blobKey);
    updateDraft(draftId, { photo_blob_keys: keys }).catch(() => {});
  }, [photos, restored]);

  function openRetake(blobKey: string) {
    retakeTargetRef.current = blobKey;
    fileInputRef.current?.click();
  }

  async function handleCapture(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    const retakeKey = retakeTargetRef.current;
    retakeTargetRef.current = null; // consume immediately (picker-cancel safe)
    if (!file || processing) return;
    // A retake replaces a slot, so it's allowed even at the cap; a plain add is not.
    if (!retakeKey && photos.length >= MAX_PHOTOS) return;

    const oldEntry = retakeKey ? photos.find((p) => p.blobKey === retakeKey) : undefined;
    if (retakeKey && !oldEntry) return; // slot vanished (removed mid-flight)

    setProcessing(true);
    setError(null);
    const previewUrl = URL.createObjectURL(file);
    const blobKey = uuidv4();

    // Optimistic slot with a pending spinner (CRITICAL #3) — appears immediately.
    setPhotos((prev) =>
      retakeKey
        ? prev.map((p) =>
            p.blobKey === retakeKey
              ? { blobKey, previewUrl, blurry: false, poorExposure: false, pending: true }
              : p,
          )
        : [...prev, { blobKey, previewUrl, blurry: false, poorExposure: false, pending: true }],
    );

    // Roll back the optimistic slot: restore the old photo on a failed retake,
    // otherwise just drop the placeholder.
    const rollback = (messageKey: "step4.readError" | "step4.saveError") => {
      URL.revokeObjectURL(previewUrl);
      setPhotos((prev) =>
        retakeKey && oldEntry
          ? prev.map((p) => (p.blobKey === blobKey ? oldEntry : p))
          : prev.filter((p) => p.blobKey !== blobKey),
      );
      setError(t(messageKey));
    };

    try {
      // assessImageQuality throws on undecodable / non-image files → reject them.
      let quality;
      try {
        quality = await assessImageQuality(file);
      } catch {
        rollback("step4.readError");
        return;
      }
      try {
        await addPhotoBlob(blobKey, file);
      } catch {
        rollback("step4.saveError");
        return;
      }
      setPhotos((prev) =>
        prev.map((p) => (p.blobKey === blobKey ? { ...p, ...quality, pending: false } : p)),
      );
      // Retake committed: drop the old blob + preview URL.
      if (oldEntry && oldEntry.blobKey !== blobKey) {
        URL.revokeObjectURL(oldEntry.previewUrl);
        deletePhotoBlob(oldEntry.blobKey).catch(() => {});
      }
    } finally {
      setProcessing(false);
    }
  }

  async function handleRemove(blobKey: string, previewUrl: string) {
    URL.revokeObjectURL(previewUrl);
    setPhotos((prev) => prev.filter((p) => p.blobKey !== blobKey));
    try {
      await deletePhotoBlob(blobKey);
    } catch {
      /* the in-memory removal already happened; a stale blob is harmless */
    }
  }

  async function handleSubmit() {
    if (saving || processing) return;
    const committed = photos.filter((p) => !p.pending);
    if (committed.length === 0) {
      setError(t("step4.minPhotoError"));
      return;
    }
    const draftId = getDraftId();
    if (!draftId) {
      router.replace("/report");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateDraft(draftId, { photo_blob_keys: committed.map((p) => p.blobKey) });
      router.push("/report/poc");
    } catch {
      setError(t("step4.saveError"));
    } finally {
      setSaving(false);
    }
  }

  const atMax = photos.length >= MAX_PHOTOS;

  function warningFor(p: PhotoEntry): string | null {
    if (p.blurry) return t("step4.blurryWarning");
    if (p.poorExposure) return t("step4.exposureWarning");
    return null;
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-design-6 px-design-5 py-design-6">
      <StepIndicator steps={steps} currentStep={3} />

      <header>
        <h1 className="text-title font-bold text-ink-primary">{t("step4.title")}</h1>
      </header>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => void handleCapture(e)}
      />

      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={atMax || processing}
        className="flex min-h-primary-btn items-center justify-center rounded-md bg-forest px-design-5 text-headline font-semibold text-ink-on-dark transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {atMax ? t("step4.maxReached") : processing ? t("step4.processing") : t("step4.addPhoto")}
      </button>

      {photos.length > 0 && (
        <div className="grid grid-cols-3 gap-design-2">
          {photos.map((p) => (
            <PhotoThumbnail
              key={p.blobKey}
              previewUrl={p.previewUrl}
              warningText={warningFor(p)}
              pending={p.pending}
              processingLabel={t("step4.processing")}
              retakeLabel={t("step4.retake")}
              removeLabel={t("step4.remove")}
              onRemove={() => void handleRemove(p.blobKey, p.previewUrl)}
              onRetake={() => openRetake(p.blobKey)}
            />
          ))}
        </div>
      )}

      <p className="text-caption text-ink-secondary">
        {t("step4.count", { count: photos.length, max: MAX_PHOTOS })}
      </p>

      {error && (
        <p role="alert" className="text-caption text-status-error">
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={saving}
        onClick={() => void handleSubmit()}
        className="flex min-h-primary-btn items-center justify-center rounded-md bg-amber px-design-5 text-headline font-semibold text-ink-on-amber transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {t("step4.submit")}
      </button>
    </main>
  );
}
