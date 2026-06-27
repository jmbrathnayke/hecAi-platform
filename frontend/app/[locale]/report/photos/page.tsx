"use client";
// Step 4 of the incident form: capture 1–10 damage photos with on-capture quality
// feedback. Blobs live in the photo_blobs store; the draft holds only blob_key refs.
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
}

export default function PhotosStep() {
  const t = useTranslations("report");
  const router = useRouter();
  const steps = [t("steps.identity"), t("steps.location"), t("steps.damage"), t("steps.photos")];

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [photos, setPhotos] = useState<PhotoEntry[]>([]);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Keep a ref of preview URLs so the unmount cleanup can revoke them all.
  const urlsRef = useRef<string[]>([]);
  urlsRef.current = photos.map((p) => p.previewUrl);

  // Restore any photos already captured (returning from a later step); redirect to
  // Step 1 if there is no draft.
  useEffect(() => {
    const draftId = getDraftId();
    if (!draftId) {
      router.replace("/report");
      return;
    }
    let active = true;
    getCase(draftId)
      .then(async (draft) => {
        const keys = (draft?.photo_blob_keys as string[] | undefined) ?? [];
        if (!active || keys.length === 0) return;
        const blobs = await listPhotoBlobs(keys);
        if (!active) return;
        setPhotos((prev) =>
          prev.length > 0
            ? prev
            : blobs.map((b) => ({
                blobKey: b.blob_key,
                previewUrl: URL.createObjectURL(b.blob),
                blurry: false,
                poorExposure: false,
              })),
        );
      })
      .catch(() => {});
    return () => {
      active = false;
      urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [router]);

  async function handleCapture(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file || photos.length >= MAX_PHOTOS || processing) return;

    setProcessing(true);
    setError(null);
    const previewUrl = URL.createObjectURL(file);
    try {
      const blobKey = uuidv4();
      const quality = await assessImageQuality(file).catch(() => ({
        blurry: false,
        poorExposure: false,
      }));
      await addPhotoBlob(blobKey, file);
      setPhotos((prev) => [...prev, { blobKey, previewUrl, ...quality }]);
    } catch {
      URL.revokeObjectURL(previewUrl);
      setError(t("step4.saveError"));
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
    if (saving) return;
    if (photos.length === 0) {
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
      await updateDraft(draftId, { photo_blob_keys: photos.map((p) => p.blobKey) });
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
              retakeLabel={t("step4.retake")}
              removeLabel={t("step4.remove")}
              onRemove={() => void handleRemove(p.blobKey, p.previewUrl)}
              onRetake={() => fileInputRef.current?.click()}
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
