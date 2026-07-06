import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import OfficerClassifyPage from "@/app/officer/classify/page";
import { assessImageQuality } from "@/lib/imageQuality";
import { classifyImage } from "@/lib/mobilenet";
import { saveClassification, getCase } from "@/lib/indexeddb";
import { getDraftId, getOrCreateDraftId } from "@/lib/draft";

jest.mock("@/lib/imageQuality", () => ({ assessImageQuality: jest.fn() }));
jest.mock("@/lib/mobilenet", () => ({ classifyImage: jest.fn() }));
jest.mock("@/lib/indexeddb", () => ({
  saveClassification: jest.fn().mockResolvedValue(undefined),
  getCase: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/draft", () => ({
  getOrCreateDraftId: jest.fn(() => "draft-1"),
  getDraftId: jest.fn(() => null),
}));

const mockAssess = assessImageQuality as jest.Mock;
const mockClassify = classifyImage as jest.Mock;
const mockSave = saveClassification as jest.Mock;
const mockGetCase = getCase as jest.Mock;
const mockGetDraftId = getDraftId as jest.Mock;

function selectPhoto() {
  const input = screen.getByTestId("classify-file-input");
  const file = new File(["x"], "damage.jpg", { type: "image/jpeg" });
  fireEvent.change(input, { target: { files: [file] } });
}

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
    expect(screen.getByText("Property Damage")).toBeInTheDocument();
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

    expect(await screen.findByRole("alert")).toHaveTextContent(/photo quality looks low/i);
    expect(await screen.findByTestId("ai-result-card")).toBeInTheDocument();
    expect(mockClassify).toHaveBeenCalledTimes(1);
  });

  it("shows an error and does not render a card when classification fails", async () => {
    mockClassify.mockRejectedValue(new Error("model unavailable"));
    render(<OfficerClassifyPage />);
    selectPhoto();

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not classify/i);
    expect(screen.queryByTestId("ai-result-card")).not.toBeInTheDocument();
  });

  it("does not advance until the officer taps Accept (NFR-6.1)", async () => {
    render(<OfficerClassifyPage />);
    selectPhoto();
    await screen.findByTestId("ai-result-card");

    expect(screen.queryByText("Assessment accepted.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(await screen.findByText("Assessment accepted.")).toBeInTheDocument();
  });
});
