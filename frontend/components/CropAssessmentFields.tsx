"use client";
// The officer's crop assessment, shown only once the settled damage class is crop damage.
//
// WHY THIS IS A FORM AND NOT A PREDICTION. MobileNetV2 answers "crop damage or property damage".
// It cannot answer "paddy or banana", and neither can any other model in this system — the crop is
// an agronomic fact about the field, not something visible in a photograph of trampled vegetation.
// Presenting it as an AI output would misrepresent what the AI did, so the control is labelled as
// the officer's own identification throughout.
//
// The three values here are what `synthetic_crop_compensation_v1` needs. Without them a crop case
// falls back to rf_compensation_v2, which was fit on {death, injury, property} and has never seen
// a field — which is the whole defect this branch exists to remove, so the parent blocks submission
// until they are valid and the server refuses the assessment independently.
import { useTranslations } from "next-intl";
import {
  CROP_AREA_TRAINED_MAX,
  CROP_TYPES,
  parseCropAssessment,
  type CropAssessment,
  type CropType,
} from "@/lib/officerCaseReview";

const FIELD =
  "min-h-touch-target w-full rounded-md border border-border-default bg-surface-raised px-design-3 text-body text-ink-primary focus:border-border-focus focus:outline-none";

type Props = {
  value: CropAssessment;
  onChange: (next: CropAssessment) => void;
  disabled?: boolean;
};

export default function CropAssessmentFields({ value, onChange, disabled = false }: Props) {
  const t = useTranslations("cropAssessment");
  const set = (patch: Partial<CropAssessment>) => onChange({ ...value, ...patch });

  const parsed = parseCropAssessment(value);
  const area = Number(value.areaAcres);
  // Warned, never blocked: a real field can be larger than the synthetic training data, and
  // refusing the assessment would be worse than flagging an estimate the model cannot support.
  const beyondTrained = parsed !== null && Number.isFinite(area) && area > CROP_AREA_TRAINED_MAX;

  return (
    <div
      className="space-y-design-3 rounded-md border border-border-subtle bg-surface-base p-design-3"
      data-testid="crop-assessment"
    >
      <div className="space-y-design-1">
        <p className="text-label font-semibold text-ink-primary">{t("heading")}</p>
        <p className="text-caption text-ink-secondary">{t("officerDeclared")}</p>
      </div>

      <label className="block space-y-design-1">
        <span className="text-caption font-semibold text-ink-primary">{t("cropType")}</span>
        <select
          id="crop-type"
          className={FIELD}
          value={value.cropType}
          disabled={disabled}
          required
          onChange={(e) => set({ cropType: e.target.value as CropType | "" })}
        >
          <option value="">{t("cropTypePlaceholder")}</option>
          {CROP_TYPES.map((crop) => (
            <option key={crop} value={crop}>
              {t(`crops.${crop}`)}
            </option>
          ))}
        </select>
      </label>

      <div className="grid grid-cols-2 gap-design-3">
        <label className="block space-y-design-1">
          <span className="text-caption font-semibold text-ink-primary">{t("areaAcres")}</span>
          <input
            id="crop-area-acres"
            type="number"
            inputMode="decimal"
            min="0"
            max="100"
            step="0.1"
            className={FIELD}
            value={value.areaAcres}
            disabled={disabled}
            required
            onChange={(e) => set({ areaAcres: e.target.value })}
          />
        </label>

        <label className="block space-y-design-1">
          <span className="text-caption font-semibold text-ink-primary">{t("extentPercent")}</span>
          <input
            id="crop-extent-percent"
            type="number"
            inputMode="numeric"
            min="0"
            max="100"
            step="1"
            className={FIELD}
            value={value.extentPercent}
            disabled={disabled}
            required
            onChange={(e) => set({ extentPercent: e.target.value })}
          />
        </label>
      </div>

      {beyondTrained && (
        <p role="status" className="text-caption text-status-warning" data-testid="crop-area-warning">
          {t("beyondTrainedArea", { max: CROP_AREA_TRAINED_MAX })}
        </p>
      )}
    </div>
  );
}
