/**
 * The crop half of an officer assessment.
 *
 * MobileNetV2 answers "crop damage or property damage"; it cannot answer "paddy or banana". So the
 * crop, the affected area and the damage extent are the officer's own inputs, and they are what
 * decides whether a case is priced by synthetic_crop_compensation_v1 or falls back to
 * rf_compensation_v2 — a model fit on {death, injury, property} that has never seen a field.
 *
 * These checks mirror compensation._crop_inputs() on the server. They exist to fail fast in the UI,
 * never as the authority: the server re-validates everything here and refuses a crop assessment
 * with a 400 regardless of what the client believed.
 */
import {
  buildAssessmentBody,
  CROP_TYPES,
  EMPTY_CROP_ASSESSMENT,
  parseCropAssessment,
  type CropAssessment,
} from "@/lib/officerCaseReview";

const classification = {
  classId: "crop_damage" as const,
  confidence: 0.9,
  severity: "Severe" as const,
  processingTimeMs: 120.4,
  modelVersion: "mobilenetv2-v1",
};

const crop = (over: Partial<CropAssessment> = {}): CropAssessment => ({
  cropType: "paddy",
  areaAcres: "2",
  extentPercent: "75",
  ...over,
});

describe("parseCropAssessment", () => {
  it("accepts every crop the model was trained on", () => {
    for (const cropType of CROP_TYPES) {
      expect(parseCropAssessment(crop({ cropType }))?.crop_type).toBe(cropType);
    }
  });

  it("returns the values as numbers, not the strings the inputs hold", () => {
    expect(parseCropAssessment(crop({ areaAcres: "1.25", extentPercent: "60" }))).toEqual({
      crop_type: "paddy",
      affected_area_acres: 1.25,
      damage_extent_percent: 60,
    });
  });

  it.each([
    ["nothing filled in", EMPTY_CROP_ASSESSMENT],
    ["a crop the model was never fit on", crop({ cropType: "mango" as never })],
    ["zero area — not an assessment", crop({ areaAcres: "0" })],
    ["negative area", crop({ areaAcres: "-1" })],
    ["a mistyped area", crop({ areaAcres: "250" })],
    ["text in the area", crop({ areaAcres: "two" })],
    ["zero extent", crop({ extentPercent: "0" })],
    ["more damage than there is field", crop({ extentPercent: "101" })],
    ["a blank extent", crop({ extentPercent: "" })],
  ])("rejects %s", (_label, value) => {
    expect(parseCropAssessment(value)).toBeNull();
  });
});

describe("buildAssessmentBody", () => {
  it("sends the crop fields when the settled class is crop damage", () => {
    const body = buildAssessmentBody(classification, null, crop());
    expect(body).toMatchObject({
      prediction: "crop_damage",
      was_overridden: false,
      crop_type: "paddy",
      affected_area_acres: 2,
      damage_extent_percent: 75,
    });
  });

  it("omits them when the officer overrode crop damage to property", () => {
    const body = buildAssessmentBody(
      classification,
      { category: "property_damage", reason: "A boundary wall, not a field." },
      crop(),
    );
    expect(body.was_overridden).toBe(true);
    expect(body).not.toHaveProperty("crop_type");
  });

  it("sends them when the officer overrode PROPERTY damage to crop", () => {
    // The override is the officer's judgement and carries the same obligations as a prediction
    // they agreed with — the server holds it to the same rule.
    const body = buildAssessmentBody(
      { ...classification, classId: "property_damage" },
      { category: "crop_damage", reason: "Paddy field trampled, not a house." },
      crop({ cropType: "banana" }),
    );
    expect(body).toMatchObject({ override_category: "crop_damage", crop_type: "banana" });
  });

  it("omits them when the crop assessment is incomplete, rather than sending a half-filled one", () => {
    const body = buildAssessmentBody(classification, null, crop({ extentPercent: "" }));
    expect(body).not.toHaveProperty("crop_type");
    expect(body).not.toHaveProperty("affected_area_acres");
  });

  it("carries no image data, only the classification result", () => {
    const body = buildAssessmentBody(classification, null, crop());
    expect(JSON.stringify(body)).not.toMatch(/blob|image|photo|base64/i);
  });
});
