import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import OfficerClassifyPage from "@/app/officer/classify/page";
import { assessImageQuality } from "@/lib/imageQuality";

// next-intl passthrough (Story 6.2): translator returns the key (+ interpolation values). Covers
// the page plus the localized AIResultCard / OverrideForm it renders.
jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, vars?: Record<string, unknown>) =>
      vars && Object.keys(vars).length ? `${key} ${Object.values(vars).join(" ")}` : key;
    t.rich = (key: string) => key;
    return t;
  },
  useLocale: () => "en",
}));
import { classifyImage } from "@/lib/mobilenet";
import { saveClassification, saveOverride, getCase } from "@/lib/indexeddb";
import { getDraftId, getOrCreateDraftId, clearDraftId } from "@/lib/draft";

jest.mock("@/lib/imageQuality", () => ({ assessImageQuality: jest.fn() }));
jest.mock("@/lib/mobilenet", () => ({ classifyImage: jest.fn() }));
jest.mock("@/lib/indexeddb", () => ({
  saveClassification: jest.fn().mockResolvedValue(undefined),
  saveOverride: jest.fn().mockResolvedValue(undefined),
  getCase: jest.fn().mockResolvedValue(undefined),
  // FieldNotes (rendered under the result card) writes the note straight to the draft.
  updateDraft: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/draft", () => ({
  getOrCreateDraftId: jest.fn(() => "draft-1"),
  getDraftId: jest.fn(() => null),
  clearDraftId: jest.fn(),
}));

const mockAssess = assessImageQuality as jest.Mock;
const mockClassify = classifyImage as jest.Mock;
const mockSave = saveClassification as jest.Mock;
const mockSaveOverride = saveOverride as jest.Mock;
const mockGetCase = getCase as jest.Mock;
const mockGetDraftId = getDraftId as jest.Mock;

function selectPhoto() {
  const input = screen.getByTestId("classify-file-input");
  const file = new File(["x"], "damage.jpg", { type: "image/jpeg" });
  fireEvent.change(input, { target: { files: [file] } });
}

// The mockup's photo strip / counter are driven by object URLs, and jsdom implements neither
// createObjectURL nor revokeObjectURL. addThumbnail() swallows the resulting TypeError by design
// (a missing thumbnail must never cost a classification), which would make every strip assertion
// below pass vacuously — so stub both, and record the revokes to prove the blobs are released.
let objectUrlSeq = 0;
const revokedUrls: string[] = [];

beforeEach(() => {
  objectUrlSeq = 0;
  revokedUrls.length = 0;
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = jest.fn(
    () => `blob:photo-${++objectUrlSeq}`,
  );
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = jest.fn((url: string) => {
    revokedUrls.push(url);
  });
});

beforeEach(() => {
  mockAssess.mockReset().mockResolvedValue({ blurry: false, poorExposure: false });
  mockClassify.mockReset().mockResolvedValue({
    classId: "property_damage",
    severity: "Severe",
    confidence: 0.89,
    processingTimeMs: 300,
    modelVersion: "mobilenetv2-v1",
  });
  mockSave.mockReset().mockResolvedValue(undefined);
  mockSaveOverride.mockReset().mockResolvedValue(undefined);
  mockGetCase.mockReset().mockResolvedValue(undefined);
  mockGetDraftId.mockReset().mockReturnValue(null);
  (getOrCreateDraftId as jest.Mock).mockReturnValue("draft-1");
});

describe("OfficerClassifyPage", () => {
  it("runs the quality check, classifies, and renders the AI Result Card", async () => {
    render(<OfficerClassifyPage />);
    selectPhoto();

    expect(await screen.findByTestId("ai-result-card")).toBeInTheDocument();
    expect(mockAssess).toHaveBeenCalledTimes(1);
    expect(mockClassify).toHaveBeenCalledTimes(1);
    expect(screen.getByText("aiResult.property_damage")).toBeInTheDocument();
    expect(screen.getByText("89%")).toBeInTheDocument();
  });

  it("persists the AI result and derived case category to the draft (AC7 + AC8)", async () => {
    render(<OfficerClassifyPage />);
    selectPhoto();

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    expect(mockSave).toHaveBeenCalledWith("draft-1", {
      ai_category: "property_damage",
      ai_confidence: 0.89,
      ai_severity: "Severe",
      ai_processing_time_ms: 300,
      ai_model_version: "mobilenetv2-v1",
      case_category: "property_damage",
    });
  });

  it("derives 'combined' once the case has both crop and property damage photos", async () => {
    mockClassify.mockResolvedValueOnce({
      classId: "crop_damage",
      severity: "Moderate",
      confidence: 0.7,
      processingTimeMs: 280,
      modelVersion: "mobilenetv2-v1",
    });
    render(<OfficerClassifyPage />);

    selectPhoto(); // crop_damage
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    expect(mockSave.mock.calls[0][1].case_category).toBe("crop_damage");

    selectPhoto(); // property_damage (default mock) → combined
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(2));
    expect(mockSave.mock.calls[1][1].case_category).toBe("combined");
  });

  it("re-hydrates the rollup from the persisted draft so it doesn't regress on reload (AC8)", async () => {
    mockGetDraftId.mockReturnValue("draft-1");
    mockGetCase.mockResolvedValue({ case_category: "crop_damage" }); // a crop photo already on the case
    render(<OfficerClassifyPage />);
    // let the mount-time re-hydration (getCase → seed classIdsRef) resolve before capturing
    await act(async () => {});

    selectPhoto(); // default mock → property_damage; unioned with the seeded crop → combined
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    expect(mockSave.mock.calls[0][1].case_category).toBe("combined");
  });

  it("ignores a second capture while one is still classifying (in-flight lock)", async () => {
    let resolveClassify!: (v: unknown) => void;
    mockClassify.mockImplementationOnce(
      () => new Promise((res) => { resolveClassify = res as (v: unknown) => void; }),
    );
    render(<OfficerClassifyPage />);

    selectPhoto(); // capture #1 — classify hangs
    selectPhoto(); // capture #2 — must be ignored while #1 is in flight

    // #1 reaches classifyImage exactly once; #2 was dropped at the guard
    await waitFor(() => expect(mockClassify).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveClassify({
        classId: "property_damage",
        severity: "Severe",
        confidence: 0.9,
        processingTimeMs: 100,
        modelVersion: "mobilenetv2-v1",
      });
    });

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    expect(mockClassify).toHaveBeenCalledTimes(1);
  });

  it("warns on low photo quality but still classifies (AC1)", async () => {
    mockAssess.mockResolvedValue({ blurry: true, poorExposure: false });
    render(<OfficerClassifyPage />);
    selectPhoto();

    expect(await screen.findByRole("alert")).toHaveTextContent(/classify.qualityWarning/i);
    expect(await screen.findByTestId("ai-result-card")).toBeInTheDocument();
    expect(mockClassify).toHaveBeenCalledTimes(1);
  });

  it("shows an error and does not render a card when classification fails", async () => {
    mockClassify.mockRejectedValue(new Error("model unavailable"));
    render(<OfficerClassifyPage />);
    selectPhoto();

    expect(await screen.findByRole("alert")).toHaveTextContent(/classify.classifyError/i);
    expect(screen.queryByTestId("ai-result-card")).not.toBeInTheDocument();
  });

  it("does not advance until the officer taps Accept (NFR-6.1)", async () => {
    render(<OfficerClassifyPage />);
    selectPhoto();
    await screen.findByTestId("ai-result-card");

    expect(screen.queryByText("classify.accepted")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "aiResult.accept" }));
    expect(await screen.findByText("classify.accepted")).toBeInTheDocument();
  });

  it("opens the OverrideForm (not the old prompt) when Override is tapped (AC1)", async () => {
    render(<OfficerClassifyPage />);
    selectPhoto();
    await screen.findByTestId("ai-result-card");

    fireEvent.click(screen.getByRole("button", { name: "aiResult.override" }));
    expect(await screen.findByTestId("override-form")).toBeInTheDocument();
    // the placeholder prompt from 3.3 is gone
    expect(screen.queryByText("Select the correct category to override.")).not.toBeInTheDocument();
  });

  it("saves the override additively and leaves the AI fields untouched (AC3)", async () => {
    // AI predicted property_damage (default mock); officer corrects it to crop_damage.
    render(<OfficerClassifyPage />);
    selectPhoto();
    await screen.findByTestId("ai-result-card");
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "aiResult.override" }));
    await screen.findByTestId("override-form");
    fireEvent.click(screen.getByLabelText("aiResult.crop_damage"));
    fireEvent.change(screen.getByLabelText("override.reasonLabel"), {
      target: { value: "paddy field flooded, not a structure" },
    });
    fireEvent.click(screen.getByRole("button", { name: "override.confirm" }));

    await waitFor(() => expect(mockSaveOverride).toHaveBeenCalledTimes(1));
    expect(mockSaveOverride).toHaveBeenCalledWith("draft-1", {
      override_applied: true,
      override_category: "crop_damage",
      override_reason: "paddy field flooded, not a structure",
      original_ai_category: "property_damage",
      case_category: "crop_damage",
    });
    // ai_* fields are never re-written by the override — only the initial classification save touched them.
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSaveOverride.mock.calls[0][1]).not.toHaveProperty("ai_category");
    expect(await screen.findByText("classify.overridden")).toBeInTheDocument();
  });

  it("recomputes case_category by substituting the corrected class for THIS photo (AC6)", async () => {
    // Photo 1: crop_damage; Photo 2: property_damage → rollup 'combined'. Override photo 2 back
    // to crop_damage → the last element is replaced → rollup collapses to 'crop_damage'.
    mockClassify.mockResolvedValueOnce({
      classId: "crop_damage",
      severity: "Moderate",
      confidence: 0.7,
      processingTimeMs: 280,
      modelVersion: "mobilenetv2-v1",
    });
    render(<OfficerClassifyPage />);

    selectPhoto(); // crop_damage
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    selectPhoto(); // property_damage (default mock) → combined
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(2));
    expect(mockSave.mock.calls[1][1].case_category).toBe("combined");

    fireEvent.click(screen.getByRole("button", { name: "aiResult.override" }));
    await screen.findByTestId("override-form");
    fireEvent.click(screen.getByLabelText("aiResult.crop_damage"));
    fireEvent.change(screen.getByLabelText("override.reasonLabel"), {
      target: { value: "second photo is also crop damage" },
    });
    fireEvent.click(screen.getByRole("button", { name: "override.confirm" }));

    await waitFor(() => expect(mockSaveOverride).toHaveBeenCalledTimes(1));
    expect(mockSaveOverride.mock.calls[0][1].case_category).toBe("crop_damage");
    expect(mockSaveOverride.mock.calls[0][1].original_ai_category).toBe("property_damage");
  });

  it("records a same-category confirm as a non-override so the metric stays honest (D1)", async () => {
    // AI predicted property_damage; officer confirms property_damage (unchanged) with a reason.
    render(<OfficerClassifyPage />);
    selectPhoto();
    await screen.findByTestId("ai-result-card");
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "aiResult.override" }));
    await screen.findByTestId("override-form");
    // leave the category at the preselected property_damage
    fireEvent.change(screen.getByLabelText("override.reasonLabel"), {
      target: { value: "looks correct, noting the collapsed roof" },
    });
    fireEvent.click(screen.getByRole("button", { name: "override.confirm" }));

    await waitFor(() => expect(mockSaveOverride).toHaveBeenCalledTimes(1));
    expect(mockSaveOverride.mock.calls[0][1].override_applied).toBe(false);
    expect(mockSaveOverride.mock.calls[0][1].override_category).toBe("property_damage");
    expect(mockSaveOverride.mock.calls[0][1].override_reason).toBe(
      "looks correct, noting the collapsed roof",
    );
  });

  it("keeps the result view and shows a retryable error if the override save fails (P3)", async () => {
    mockSaveOverride.mockRejectedValueOnce(new Error("quota exceeded"));
    render(<OfficerClassifyPage />);
    selectPhoto();
    await screen.findByTestId("ai-result-card");

    fireEvent.click(screen.getByRole("button", { name: "aiResult.override" }));
    await screen.findByTestId("override-form");
    fireEvent.click(screen.getByLabelText("aiResult.crop_damage"));
    fireEvent.change(screen.getByLabelText("override.reasonLabel"), {
      target: { value: "paddy field flooded, not a structure" },
    });
    fireEvent.click(screen.getByRole("button", { name: "override.confirm" }));

    // an override-specific error appears; the classification "retake photo" error does NOT
    expect(await screen.findByText(/classify.overrideError/i)).toBeInTheDocument();
    expect(screen.queryByText(/classify.classifyError/i)).not.toBeInTheDocument();
    // result view (and the form with the typed reason) stays mounted; not marked recorded
    expect(screen.getByTestId("ai-result-card")).toBeInTheDocument();
    expect(screen.getByTestId("override-form")).toBeInTheDocument();
    expect(screen.queryByText("classify.overridden")).not.toBeInTheDocument();
  });

  it("does not let Accept contradict a recorded override (P4)", async () => {
    render(<OfficerClassifyPage />);
    selectPhoto();
    await screen.findByTestId("ai-result-card");

    fireEvent.click(screen.getByRole("button", { name: "aiResult.override" }));
    await screen.findByTestId("override-form");
    fireEvent.click(screen.getByLabelText("aiResult.crop_damage"));
    fireEvent.change(screen.getByLabelText("override.reasonLabel"), {
      target: { value: "paddy field flooded, not a structure" },
    });
    fireEvent.click(screen.getByRole("button", { name: "override.confirm" }));
    expect(await screen.findByText("classify.overridden")).toBeInTheDocument();

    // tapping Accept now must not flip to "Assessment accepted." (would contradict the save)
    fireEvent.click(screen.getByRole("button", { name: "aiResult.accept" }));
    expect(screen.queryByText("classify.accepted")).not.toBeInTheDocument();
    expect(screen.getByText("classify.overridden")).toBeInTheDocument();
  });

  it("'Start new case' clears the rollup so the next case does not inherit prior photos (Story 3.5 AC7)", async () => {
    // Photo 1: crop_damage → rollup 'crop_damage'. Start new case. Photo 2: property_damage
    // → rollup must be 'property_damage' (NOT 'combined'), proving classIdsRef was reset.
    mockClassify.mockResolvedValueOnce({
      classId: "crop_damage",
      severity: "Moderate",
      confidence: 0.7,
      processingTimeMs: 280,
      modelVersion: "mobilenetv2-v1",
    });
    render(<OfficerClassifyPage />);

    selectPhoto(); // crop_damage
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    expect(mockSave.mock.calls[0][1].case_category).toBe("crop_damage");

    fireEvent.click(screen.getByRole("button", { name: "classify.startNewCase" }));
    expect(clearDraftId as jest.Mock).toHaveBeenCalledTimes(1);
    // the result card is torn down back to idle
    expect(screen.queryByTestId("ai-result-card")).not.toBeInTheDocument();

    selectPhoto(); // property_damage (default mock) — must NOT union with the previous crop photo
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(2));
    expect(mockSave.mock.calls[1][1].case_category).toBe("property_damage");
  });

  it("returns to the result view (Accept still available) when the override is cancelled", async () => {
    render(<OfficerClassifyPage />);
    selectPhoto();
    await screen.findByTestId("ai-result-card");

    fireEvent.click(screen.getByRole("button", { name: "aiResult.override" }));
    await screen.findByTestId("override-form");
    fireEvent.click(screen.getByRole("button", { name: "override.cancel" }));

    expect(screen.queryByTestId("override-form")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "aiResult.accept" })).toBeInTheDocument();
    expect(mockSaveOverride).not.toHaveBeenCalled();
  });
});

// officer-camera.html: step bar, in-app camera, "N of 10 photos taken", photo strip, field notes.
describe("OfficerClassifyPage — camera screen chrome", () => {
  it("titles the screen in the top bar and keeps the 'Start new case' action, with no step rail", () => {
    render(<OfficerClassifyPage />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("classify.title");
    // Classify is a standalone screen, not a step in the officer-assisted wizard — the bar
    // carries the action instead of dots.
    const bar = screen.getByTestId("officer-top-bar");
    expect(bar.querySelectorAll("[data-state]")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "classify.startNewCase" })).toBeInTheDocument();
  });

  it("falls back to the gallery picker where there is no camera, keeping the page's own test id", async () => {
    // jsdom exposes no navigator.mediaDevices — the same path as an insecure origin or an old
    // webview. The capture route must still exist rather than the screen becoming a dead end.
    render(<OfficerClassifyPage />);

    await waitFor(() =>
      expect(screen.getByTestId("camera-capture")).toHaveAttribute("data-state", "unavailable"),
    );
    expect(screen.getByTestId("classify-file-input")).toBeInTheDocument();
  });

  it("shows the photo strip and running count only once a photo has been classified", async () => {
    render(<OfficerClassifyPage />);

    expect(screen.queryByTestId("photo-strip")).not.toBeInTheDocument();
    expect(screen.getByText("camera.count 0 10")).toBeInTheDocument();
    expect(screen.getByText("camera.instruction")).toBeInTheDocument();

    selectPhoto();
    await screen.findByTestId("ai-result-card");

    expect(screen.getByTestId("photo-strip")).toBeInTheDocument();
    expect(screen.getByText("classify.photosCaptured 1")).toBeInTheDocument();
    expect(screen.getByText("camera.count 1 10")).toBeInTheDocument();
  });

  it("stops accepting photos at the 10-photo cap and says so", async () => {
    render(<OfficerClassifyPage />);

    for (let i = 1; i <= 10; i++) {
      selectPhoto();
      // Waiting on the rendered counter (not just the classify mock) also proves the previous
      // capture released the in-flight lock before the next one is fired.
      await screen.findByText(`camera.count ${i} 10`);
    }
    expect(mockClassify).toHaveBeenCalledTimes(10);
    expect(screen.getByText("camera.maxReached 10")).toBeInTheDocument();

    // An 11th capture (a race past the disabled shutter) is dropped, not classified.
    selectPhoto();
    await act(async () => {});
    expect(mockClassify).toHaveBeenCalledTimes(10);
    expect(screen.getByText("camera.count 10 10")).toBeInTheDocument();
  });

  it("offers the field-notes box only once there is a result to annotate", async () => {
    render(<OfficerClassifyPage />);
    expect(screen.queryByTestId("field-notes")).not.toBeInTheDocument();

    selectPhoto();
    await screen.findByTestId("ai-result-card");

    expect(screen.getByTestId("field-notes")).toBeInTheDocument();
  });

  it("'Start new case' empties the strip, revokes its blobs, and clears the previous field note", async () => {
    render(<OfficerClassifyPage />);
    selectPhoto();
    await screen.findByTestId("ai-result-card");

    fireEvent.change(screen.getByTestId("field-notes"), {
      target: { value: "Approx 1.5 acres of paddy affected, east section of field." },
    });
    expect(screen.getByTestId("field-notes")).toHaveValue(
      "Approx 1.5 acres of paddy affected, east section of field.",
    );

    fireEvent.click(screen.getByRole("button", { name: "classify.startNewCase" }));

    expect(screen.queryByTestId("photo-strip")).not.toBeInTheDocument();
    expect(screen.getByText("camera.count 0 10")).toBeInTheDocument();
    // Every URL the strip minted is released — otherwise each case leaks a blob for the
    // lifetime of the document, and officers keep this page open all day.
    expect(revokedUrls).toEqual(["blob:photo-1"]);

    // The next citizen must not be greeted by the previous citizen's note.
    selectPhoto();
    await screen.findByTestId("ai-result-card");
    expect(screen.getByTestId("field-notes")).toHaveValue("");
  });
});
