// Case-level damage category derivation (Story 3.3, FR-2.1). A case can carry several photos,
// each classified per-image into one of the 3 model classes. The case-level category is a
// derived rollup — notably "combined" is NOT a model class; it emerges only when a single case
// has both crop and property damage among its photos.
//
// Vocabulary is kept in the raw snake_case `classId` space end-to-end; title-case display
// strings ("Combined", "No Damage") are a render-layer concern, not stored here.

import type { ClassId } from "@/lib/mobilenet";

export type CaseCategory = "crop_damage" | "property_damage" | "combined" | "no_damage";

/**
 * Roll up per-photo class ids into the case-level category:
 *  - "combined"  when both crop_damage and property_damage appear among the photos
 *  - the single damage class present, when only one kind of damage appears
 *  - "no_damage" when there is no damage (or no classified photos yet)
 */
export function deriveCaseCategory(classIds: ClassId[]): CaseCategory {
  const hasCrop = classIds.includes("crop_damage");
  const hasProperty = classIds.includes("property_damage");

  if (hasCrop && hasProperty) return "combined";
  if (hasCrop) return "crop_damage";
  if (hasProperty) return "property_damage";
  return "no_damage";
}
