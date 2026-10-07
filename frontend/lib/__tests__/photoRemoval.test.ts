/**
 * Taking a photo back out of an officer's case (2026-10-07): a frame captured by accident had no
 * way out. These pin what removal does to the session's photos, the case rollup and the draft.
 */
import { planPhotoRemoval } from "@/lib/photoRemoval";
import type { ClassificationResult } from "@/lib/mobilenet";

function r(classId: ClassificationResult["classId"], extra: Partial<ClassificationResult> = {}): ClassificationResult {
  return {
    classId, severity: classId === "no_damage" ? "None" : "Moderate", confidence: 0.9,
    processingTimeMs: 100, modelVersion: "mobilenetv2-v1", outOfDomain: false, domainDistance: 0.1,
    gateApplied: true, rawClassId: null, rawConfidence: null, gateVersion: "g1",
    ...extra,
  } as ClassificationResult;
}

describe("planPhotoRemoval", () => {
  it("removing an earlier photo changes only the case rollup", () => {
    const plan = planPhotoRemoval(["crop_damage", "property_damage"], [r("crop_damage"), r("property_damage")], 0)!;
    expect(plan.results.map((x) => x.classId)).toEqual(["property_damage"]);
    expect(plan.classIds).toEqual(["property_damage"]);
    expect(plan.currentChanged).toBe(false);
    expect(plan.draftFields).toEqual({ case_category: "property_damage" });
  });

  it("removing the latest photo hands the case back to the previous one and drops its override", () => {
    // The accidental frame was the last one taken; the officer had overridden it.
    const plan = planPhotoRemoval(
      ["crop_damage", "property_damage"],
      [r("crop_damage"), r("no_damage", { outOfDomain: true })],
      1,
    )!;
    expect(plan.currentChanged).toBe(true);
    expect(plan.current?.classId).toBe("crop_damage");
    expect(plan.classIds).toEqual(["crop_damage"]);
    expect(plan.draftFields).toMatchObject({
      ai_category: "crop_damage",
      ai_out_of_domain: false,
      case_category: "crop_damage",
      override_applied: undefined,
      override_category: undefined,
      override_reason: undefined,
      original_ai_category: undefined,
    });
  });

  it("removing the only photo clears the case's classification entirely", () => {
    const plan = planPhotoRemoval(["no_damage"], [r("no_damage")], 0)!;
    expect(plan.current).toBeNull();
    expect(plan.results).toEqual([]);
    expect(plan.classIds).toEqual([]);
    expect(plan.draftFields).toMatchObject({ ai_category: undefined, case_category: undefined, override_category: undefined });
    expect("ai_category" in plan.draftFields).toBe(true);
  });

  it("keeps classes re-hydrated from before a reload, which belong to no photo on screen", () => {
    // After a reload the rollup came back from the draft, but the photos (object URLs) did not.
    const plan = planPhotoRemoval(["property_damage", "crop_damage"], [r("crop_damage")], 0)!;
    expect(plan.classIds).toEqual(["property_damage"]);
    expect(plan.current).toBeNull();
    expect(plan.draftFields).toEqual({ case_category: "property_damage" });
  });

  it("refuses an index that is not a photo on screen", () => {
    expect(planPhotoRemoval(["crop_damage"], [r("crop_damage")], 1)).toBeNull();
    expect(planPhotoRemoval(["crop_damage"], [r("crop_damage")], -1)).toBeNull();
    expect(planPhotoRemoval([], [r("crop_damage")], 0)).toBeNull();
  });
});
