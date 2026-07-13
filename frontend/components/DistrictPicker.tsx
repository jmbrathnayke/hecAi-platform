"use client";

// District / DS-Division cascading picker (Story 5.2 Task 7).
//
// Additive only — never blocks submission. The reference data (compensation_long.csv's
// own district/ds_division vocabulary, Sinhala strings verbatim) is statically imported
// from public/data/district_reference.json so it ships inside the precached app shell
// bundle, same offline-safety pattern as mobilenet.ts's severity_mapping.json import —
// no Service Worker precache entry needed.
//
// Labels are passed in as props (not read via useTranslations internally) so this
// component works unmodified on both the localized citizen tree (Story 2.1) and the
// English-only officer tree (Story 3.5, FR-9.3, no next-intl provider).
import { useEffect, useMemo, useRef, useState } from "react";
import districtReference from "@/public/data/district_reference.json";

export interface DistrictSelection {
  district: string;
  dsDivision: string;
}

interface DistrictPickerProps {
  value: DistrictSelection | null;
  onChange: (value: DistrictSelection | null) => void;
  districtLabel: string;
  districtPlaceholder: string;
  dsDivisionLabel: string;
  dsDivisionPlaceholder: string;
}

const REFERENCE = districtReference as Record<string, string[]>;
const DISTRICTS = Object.keys(REFERENCE);

export function DistrictPicker({
  value,
  onChange,
  districtLabel,
  districtPlaceholder,
  dsDivisionLabel,
  dsDivisionPlaceholder,
}: DistrictPickerProps) {
  const [district, setDistrict] = useState(value?.district ?? "");
  const divisions = useMemo(() => (district ? (REFERENCE[district] ?? []) : []), [district]);

  // Code review fix: `value` can change out from under us after mount (e.g. a caller
  // reloading a saved draft, or a future "clear form" action) — resync local state
  // instead of only reading the prop once at construction time.
  //
  // `lastEmitted` distinguishes an external reset from our own onChange echoing back
  // through the parent's state. Picking a district alone calls onChange(null) (an
  // incomplete pair) — without this guard, that null would come back around as a
  // "value changed" signal and immediately stomp the district the user just picked.
  const lastEmitted = useRef<DistrictSelection | null>(null);

  useEffect(() => {
    if (value === lastEmitted.current) return;
    setDistrict(value?.district ?? "");
  }, [value]);

  function emit(next: DistrictSelection | null) {
    lastEmitted.current = next;
    onChange(next);
  }

  function handleDistrictChange(next: string) {
    setDistrict(next);
    // Changing (or clearing) the district invalidates any previously selected division —
    // a division belongs to exactly one district, so a stale pairing must never be sent.
    emit(null);
  }

  function handleDivisionChange(next: string) {
    if (!district || !next) {
      emit(null);
      return;
    }
    emit({ district, dsDivision: next });
  }

  return (
    <div className="flex flex-col gap-design-3">
      <div className="flex flex-col gap-design-1">
        <label
          htmlFor="district-picker-district"
          className="text-label font-medium text-ink-secondary"
        >
          {districtLabel}
        </label>
        <select
          id="district-picker-district"
          value={district}
          onChange={(e) => handleDistrictChange(e.target.value)}
          className="min-h-touch-target rounded-md border border-border-default bg-surface-raised px-design-3 text-body text-ink-primary"
        >
          <option value="">{districtPlaceholder}</option>
          {DISTRICTS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </div>

      {district && (
        <div className="flex flex-col gap-design-1">
          <label
            htmlFor="district-picker-division"
            className="text-label font-medium text-ink-secondary"
          >
            {dsDivisionLabel}
          </label>
          <select
            id="district-picker-division"
            value={
              value?.district === district && divisions.includes(value.dsDivision)
                ? value.dsDivision
                : ""
            }
            onChange={(e) => handleDivisionChange(e.target.value)}
            className="min-h-touch-target rounded-md border border-border-default bg-surface-raised px-design-3 text-body text-ink-primary"
          >
            <option value="">{dsDivisionPlaceholder}</option>
            {divisions.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
