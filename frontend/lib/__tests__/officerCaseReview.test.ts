import {
  buildAssessmentBody,
  getOfficerCase,
  isDeliveryEvent,
  startOfficerReview,
  submitOfficerAssessment,
} from "@/lib/officerCaseReview";
import { buildCasePayload, classificationFromDraft, toPoCRecord } from "@/lib/poc";
import { getAccessToken } from "@/lib/auth";

jest.mock("@/lib/auth", () => ({ getAccessToken: jest.fn() }));
jest.mock("@/lib/indexeddb", () => ({ putCase: jest.fn() }));

const mockToken = getAccessToken as jest.Mock;
const fetchMock = jest.fn();

const RESULT = {
  classId: "crop_damage" as const,
  confidence: 0.91,
  severity: "Moderate" as const,
  processingTimeMs: 143.6,
  modelVersion: "mobilenetv2-v1",
};

beforeEach(() => {
  mockToken.mockReset().mockResolvedValue("tok");
  fetchMock.mockReset();
  global.fetch = fetchMock;
});

function reply(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

describe("buildAssessmentBody", () => {
  it("sends only the classification result — never an image", () => {
    const body = buildAssessmentBody(RESULT, null);
    expect(body).toEqual({
      model_type: "mobilenetv2",
      model_version: "mobilenetv2-v1",
      prediction: "crop_damage",
      confidence: 0.91,
      ai_severity: "Moderate",
      ai_processing_time_ms: 144,
      was_overridden: false,
      override_category: null,
      override_reason: null,
    });
    expect(JSON.stringify(body)).not.toMatch(/image|photo|blob|base64/i);
  });

  it("records the officer's correction beside the model's prediction", () => {
    const body = buildAssessmentBody(RESULT, {
      category: "property_damage",
      reason: "  Wall and roof damaged, crops intact.  ",
    });
    expect(body).toMatchObject({
      prediction: "crop_damage",
      was_overridden: true,
      override_category: "property_damage",
      override_reason: "Wall and roof damaged, crops intact.",
    });
  });

  it("sends the open-set gate's record beside the served class", () => {
    // `prediction` is what the workflow acted on. The gate fields say how it was reached, so
    // inference_log can still separate "the model saw undamaged land" from "the model recognised
    // nothing at all" — both of which are stored as no_damage.
    const body = buildAssessmentBody(
      {
        classId: "no_damage",
        confidence: 0,
        severity: "None",
        processingTimeMs: 210,
        modelVersion: "mobilenetv2-v1",
        outOfDomain: true,
        domainDistance: 0.664,
        gateApplied: true,
        rawClassId: "property_damage",
        rawConfidence: 0.94,
        gateVersion: "ncm-cosine-v1",
      },
      null,
    );
    expect(body).toMatchObject({
      prediction: "no_damage",
      ai_severity: "None",
      ai_out_of_domain: true,
      ai_domain_distance: 0.664,
      ai_raw_prediction: "property_damage",
      ai_raw_confidence: 0.94,
      ai_gate_version: "ncm-cosine-v1",
      ai_gate_applied: true,
    });
  });

  it("omits the gate fields for a result that has none, rather than sending nulls", () => {
    const body = buildAssessmentBody(RESULT, null);
    expect(body).not.toHaveProperty("ai_gate_version");
    expect(body).not.toHaveProperty("ai_out_of_domain");
  });

  it("does not count a 'correction' to the predicted class as an override", () => {
    const body = buildAssessmentBody(RESULT, { category: "crop_damage", reason: "confirmed on site" });
    expect(body.was_overridden).toBe(false);
  });
});

describe("API calls", () => {
  const DETAIL = { case: { canonical_id: "HEC-2026-0001" }, workflow: {}, actions: {} };

  it("reads the case with the officer's token", async () => {
    fetchMock.mockResolvedValue(reply(200, DETAIL));
    const res = await getOfficerCase("HEC-2026-0001");
    expect(res).toEqual({ ok: true, detail: DETAIL });
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/v1\/officer\/cases\/HEC-2026-0001$/);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer tok");
  });

  it("posts the review start and the assessment to the case's own endpoints", async () => {
    fetchMock.mockResolvedValue(reply(200, DETAIL));
    await startOfficerReview("HEC-2026-0001");
    await submitOfficerAssessment("HEC-2026-0001", buildAssessmentBody(RESULT, null));
    expect(fetchMock.mock.calls[0][0]).toMatch(/start-review$/);
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    expect(fetchMock.mock.calls[1][0]).toMatch(/assessment$/);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).prediction).toBe("crop_damage");
  });

  it.each([
    [404, { error: "not_found" }, { reason: "not-found" }],
    [401, { error: "token_expired" }, { reason: "signed-out" }],
    [403, { error: "forbidden" }, { reason: "forbidden" }],
    [409, { error: "case_not_open", status: "Approved" }, { reason: "closed", status: "Approved" }],
    [400, { error: "override_reason_too_short" }, { reason: "invalid", code: "override_reason_too_short" }],
    [500, { error: "server_error" }, { reason: "server", status: 500 }],
  ])("maps HTTP %i to a distinct failure", async (status, body, failure) => {
    fetchMock.mockResolvedValue(reply(status, body));
    await expect(getOfficerCase("HEC-2026-0001")).resolves.toEqual({ ok: false, failure });
  });

  it("reports a transport failure as network, and no session without calling the API", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(getOfficerCase("HEC-2026-0001")).resolves.toEqual({ ok: false, failure: { reason: "network" } });
    mockToken.mockResolvedValue(null);
    fetchMock.mockClear();
    await expect(getOfficerCase("HEC-2026-0001")).resolves.toEqual({ ok: false, failure: { reason: "no-session" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("history filtering", () => {
  it("hides notification-delivery bookkeeping from the officer's case history", () => {
    expect(isDeliveryEvent("push_skipped_not_configured")).toBe(true);
    expect(isDeliveryEvent("staff_push_skipped_no_subscription")).toBe(true);
    expect(isDeliveryEvent("email_sent")).toBe(true);
    expect(isDeliveryEvent("officer_assessment_recorded")).toBe(false);
  });
});

describe("officer-assisted submission carries the on-device classification", () => {
  const officerDraft = {
    offline_id: "o-1",
    damage_category: "property",
    ai_category: "crop_damage",
    ai_confidence: 0.77,
    ai_severity: "Severe",
    ai_processing_time_ms: 88.2,
    ai_model_version: "mobilenetv2-v1",
    override_applied: true,
    override_category: "property_damage",
    override_reason: "Roof collapsed; no crops on this plot.",
    submitted_by_officer: true,
  };

  it("builds the classification from what the classify step stored", () => {
    expect(classificationFromDraft(officerDraft)).toEqual({
      model_type: "mobilenetv2",
      model_version: "mobilenetv2-v1",
      prediction: "crop_damage",
      confidence: 0.77,
      ai_processing_time_ms: 88,
      was_overridden: true,
      override_category: "property_damage",
      override_reason: "Roof collapsed; no crops on this plot.",
    });
  });

  it("carries the open-set gate's record through the offline path", () => {
    // An offline submission must arrive with the same evidence an online assessment posts, or a
    // case synced from the field loses the distinction between "undamaged land" and "the model
    // recognised nothing" — which is the only thing that explains a no_damage result.
    const gated = {
      ...officerDraft,
      ai_category: "no_damage",
      ai_confidence: 0,
      override_applied: false,
      ai_gate_version: "ncm-cosine-v1",
      ai_gate_applied: true,
      ai_out_of_domain: true,
      ai_domain_distance: 0.664,
      ai_raw_prediction: "property_damage",
      ai_raw_confidence: 0.94,
    };
    expect(classificationFromDraft(gated)).toMatchObject({
      prediction: "no_damage",
      ai_out_of_domain: true,
      ai_domain_distance: 0.664,
      ai_raw_prediction: "property_damage",
      ai_raw_confidence: 0.94,
    });
  });

  it("omits the gate fields entirely for a draft classified before the gate existed", () => {
    // Absent must not become false: the server distinguishes "this predates the gate" from
    // "the gate ran and the photo passed", and only the omission can say the first.
    const body = classificationFromDraft(officerDraft) as Record<string, unknown>;
    expect(body).not.toHaveProperty("ai_gate_version");
    expect(body).not.toHaveProperty("ai_out_of_domain");
  });

  it("is sent on the officer path", () => {
    const record = { ...toPoCRecord(officerDraft, "o-1", "2026-09-17T08:00:00Z", "h"), submitted_by_officer: true, officer_id: "officer-1" };
    expect(buildCasePayload(record).ai_classification).toMatchObject({ prediction: "crop_damage" });
  });

  it("is never sent on the citizen path", () => {
    const citizenRecord = toPoCRecord({ offline_id: "c-1", damage_category: "crop" }, "c-1", "2026-09-17T08:00:00Z", "h");
    expect(classificationFromDraft({ offline_id: "c-1" })).toBeUndefined();
    expect(buildCasePayload(citizenRecord)).not.toHaveProperty("ai_classification");
    // Even a stray classification on a record not flagged officer-assisted is not forwarded.
    const stray = toPoCRecord(officerDraft, "o-1", "2026-09-17T08:00:00Z", "h");
    expect(buildCasePayload(stray)).not.toHaveProperty("ai_classification");
  });
});

describe("what was classified (2026-10-02)", () => {
  const RESULT = { classId: "property_damage" as const, confidence: 0.9, severity: "Severe" as const,
                   processingTimeMs: 100, modelVersion: "mobilenetv2-v1" };

  it("names the family's photograph when it was the input", () => {
    expect(buildAssessmentBody(RESULT, null, null, { kind: "citizen_photo", photoId: 11 })).toMatchObject({
      input_source: "citizen_photo",
      input_photo_id: 11,
    });
  });

  it("leaves the body of an officer-capture assessment exactly as it always was", () => {
    const body = buildAssessmentBody(RESULT, null, null, { kind: "camera" });
    expect(body).not.toHaveProperty("input_source");
    expect(body).not.toHaveProperty("input_photo_id");
    expect(buildAssessmentBody(RESULT, null)).toEqual(body);
  });
});
