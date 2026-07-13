import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import OfficerSubmitPage from "@/app/officer/submit/page";
import { encryptField } from "@/lib/crypto";
import { updateDraft, getCase, saveClassification } from "@/lib/indexeddb";
import { buildPoC, submitCaseOnline } from "@/lib/poc";
import { classifyImage } from "@/lib/mobilenet";
import { assessImageQuality } from "@/lib/imageQuality";
import { getCurrentPosition } from "@/lib/geolocation";
import { getDraftId, clearDraftId } from "@/lib/draft";
import { clearOfficerPocMask } from "@/lib/officerPoc";
import { createClient } from "@/lib/supabase";

const push = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: jest.fn() }),
}));

// Leaflet-based picker is never reached in these tests (GPS resolves) — mock so its dynamic
// import can't drag Leaflet into jsdom.
jest.mock("@/components/MapPinPicker", () => ({
  __esModule: true,
  default: () => null,
}));

// The ciphertext deliberately does NOT embed the plaintext (real AES-GCM output is opaque
// base64) so the "plaintext never persisted" assertion is meaningful.
// The ciphertext deliberately does NOT embed the plaintext (real AES-GCM output is opaque
// base64) so the "plaintext never persisted" assertion is meaningful. Prefixed `mock*` so the
// hoisted jest.mock factory may reference it.
const mockCipherMap: Record<string, string> = {
  "200012345678": "nic-ciphertext-xyz",
  "0712345678": "mobile-ciphertext-xyz",
};
jest.mock("@/lib/crypto", () => ({
  getOrCreateSessionKey: jest.fn().mockResolvedValue("fake-key"),
  encryptField: jest.fn((plaintext: string) =>
    Promise.resolve({ ciphertext: mockCipherMap[plaintext] ?? "ct", iv: "iv-xyz" }),
  ),
}));

jest.mock("@/lib/indexeddb", () => ({
  updateDraft: jest.fn().mockResolvedValue(undefined),
  getCase: jest.fn().mockResolvedValue(undefined),
  saveClassification: jest.fn().mockResolvedValue(undefined),
  saveOverride: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/draft", () => ({
  getOrCreateDraftId: jest.fn(() => "draft-1"),
  getDraftId: jest.fn(() => null),
  clearDraftId: jest.fn(),
}));

jest.mock("@/lib/officerPoc", () => ({
  OFFICER_POC_NIC_KEY: "hec-officer-poc-nic-last4",
  clearOfficerPocMask: jest.fn(),
}));

jest.mock("@/lib/poc", () => ({
  buildPoC: jest.fn(),
  submitCaseOnline: jest.fn(),
}));

jest.mock("@/lib/mobilenet", () => ({ classifyImage: jest.fn() }));
jest.mock("@/lib/imageQuality", () => ({ assessImageQuality: jest.fn() }));
jest.mock("@/lib/geolocation", () => ({ getCurrentPosition: jest.fn() }));

// The factory stays empty of behavior — every test's session shape is set via
// createClient.mockReturnValue(...) at runtime (in beforeEach / individual tests), which avoids
// referencing any outer "mock*"-hoisted variable from inside this factory.
jest.mock("@/lib/supabase", () => ({
  createClient: jest.fn(),
}));

const mockEncrypt = encryptField as jest.Mock;
const mockUpdateDraft = updateDraft as jest.Mock;
const mockGetCase = getCase as jest.Mock;
const mockBuildPoC = buildPoC as jest.Mock;
const mockSubmit = submitCaseOnline as jest.Mock;
const mockClassify = classifyImage as jest.Mock;
const mockAssess = assessImageQuality as jest.Mock;
const mockGps = getCurrentPosition as jest.Mock;
const mockGetDraftId = getDraftId as jest.Mock;
const mockClearDraftId = clearDraftId as jest.Mock;
const mockClearOfficerPocMask = clearOfficerPocMask as jest.Mock;
const mockCreateClient = createClient as jest.Mock;

function mockSession(session: { access_token: string; user: { id: string } } | null) {
  mockCreateClient.mockReturnValue({
    auth: { getSession: jest.fn().mockResolvedValue({ data: { session } }) },
  });
}

beforeEach(() => {
  push.mockReset();
  mockEncrypt.mockClear();
  mockUpdateDraft.mockReset().mockResolvedValue(undefined);
  mockGetDraftId.mockReset().mockReturnValue(null);
  mockClearDraftId.mockReset();
  mockClearOfficerPocMask.mockReset();
  mockCreateClient.mockReset();
  mockSession({ access_token: "officer-token", user: { id: "officer-1" } });
  mockGetCase.mockReset().mockResolvedValue({
    offline_id: "draft-1",
    reporter_nic_ciphertext: "enc(200012345678)",
    officer_id: "officer-1",
    submitted_by_officer: true,
  });
  (saveClassification as jest.Mock).mockReset().mockResolvedValue(undefined);
  mockBuildPoC.mockReset().mockResolvedValue({
    offline_id: "off-123",
    timestamp_local: "2026-07-07T10:00:00.000Z",
    gps: null,
    damage_category: "crop",
    submitter_identity_hash: "hash-1",
    sync_status: "pending",
  });
  mockSubmit.mockReset().mockResolvedValue({ canonical_id: "HEC-2026-0009", offline_id: "off-123" });
  mockClassify.mockReset().mockResolvedValue({
    classId: "property_damage",
    severity: "Severe",
    confidence: 0.9,
    processingTimeMs: 200,
    modelVersion: "mobilenetv2-v1",
  });
  mockAssess.mockReset().mockResolvedValue({ blurry: false, poorExposure: false });
  mockGps.mockReset().mockResolvedValue({ latitude: 7.2, longitude: 80.6 });
  try {
    sessionStorage.clear();
  } catch {}
});

// Drives the flow from the identity step through to the review step.
async function walkToReview() {
  render(<OfficerSubmitPage />);
  // let the session effect (officer_id/token) resolve
  await act(async () => {});

  // Identity
  fireEvent.change(screen.getByLabelText(/Citizen's NIC/i), { target: { value: "200012345678" } });
  fireEvent.change(screen.getByLabelText(/Citizen's mobile/i), { target: { value: "0712345678" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));

  // Location (GPS resolves → Continue)
  await screen.findByText(/GPS location detected/i);
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));

  // Damage
  await screen.findByRole("radiogroup", { name: /Damage category/i });
  fireEvent.click(screen.getByRole("radio", { name: /Crop Damage/i }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));

  // Classify
  const input = await screen.findByTestId("submit-file-input");
  fireEvent.change(input, {
    target: { files: [new File(["x"], "damage.jpg", { type: "image/jpeg" })] },
  });
  await screen.findByTestId("ai-result-card");
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  fireEvent.click(await screen.findByRole("button", { name: /Review & Submit/i }));

  await screen.findByRole("button", { name: /Submit report/i });
}

describe("OfficerSubmitPage", () => {
  it("encrypts the citizen NIC + mobile and stores ciphertext (never plaintext) on the draft (AC2)", async () => {
    render(<OfficerSubmitPage />);
    await act(async () => {});

    fireEvent.change(screen.getByLabelText(/Citizen's NIC/i), { target: { value: "200012345678" } });
    fireEvent.change(screen.getByLabelText(/Citizen's mobile/i), { target: { value: "0712345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(mockUpdateDraft).toHaveBeenCalled());
    expect(mockEncrypt).toHaveBeenCalledWith("200012345678", "fake-key");
    expect(mockEncrypt).toHaveBeenCalledWith("0712345678", "fake-key");

    const [, fields] = mockUpdateDraft.mock.calls[0];
    expect(fields.reporter_nic_ciphertext).toBe("nic-ciphertext-xyz");
    expect(fields.reporter_mobile_ciphertext).toBe("mobile-ciphertext-xyz");
    // plaintext NIC/mobile must NEVER be written to the draft
    expect(JSON.stringify(fields)).not.toContain("200012345678");
    expect(JSON.stringify(fields)).not.toContain("0712345678");
    expect(fields.submitted_by_officer).toBe(true);
    expect(fields.officer_id).toBe("officer-1");
  });

  it("runs on-device classification and renders the AIResultCard (AC3)", async () => {
    render(<OfficerSubmitPage />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText(/Citizen's NIC/i), { target: { value: "200012345678" } });
    fireEvent.change(screen.getByLabelText(/Citizen's mobile/i), { target: { value: "0712345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText(/GPS location detected/i);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("radiogroup", { name: /Damage category/i });
    fireEvent.click(screen.getByRole("radio", { name: /Crop Damage/i }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const input = await screen.findByTestId("submit-file-input");
    fireEvent.change(input, {
      target: { files: [new File(["x"], "damage.jpg", { type: "image/jpeg" })] },
    });

    expect(await screen.findByTestId("ai-result-card")).toBeInTheDocument();
    expect(mockClassify).toHaveBeenCalledTimes(1);
    expect(saveClassification as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it("persists a picked district/DS-division onto the draft (Story 5.2 Task 7)", async () => {
    render(<OfficerSubmitPage />);
    await act(async () => {});

    fireEvent.change(screen.getByLabelText(/Citizen's NIC/i), { target: { value: "200012345678" } });
    fireEvent.change(screen.getByLabelText(/Citizen's mobile/i), { target: { value: "0712345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText(/GPS location detected/i);

    const districtSelect = screen.getByLabelText("District (optional)") as HTMLSelectElement;
    const district = districtSelect.options[1].value;
    fireEvent.change(districtSelect, { target: { value: district } });
    const divisionSelect = screen.getByLabelText("DS Division (optional)") as HTMLSelectElement;
    const division = divisionSelect.options[1].value;
    fireEvent.change(divisionSelect, { target: { value: division } });

    mockUpdateDraft.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(mockUpdateDraft).toHaveBeenCalled());
    const [, fields] = mockUpdateDraft.mock.calls[0];
    expect(fields.district).toBe(district);
    expect(fields.ds_division).toBe(division);
  });

  it("leaves district/ds_division undefined on the draft when the picker is left untouched", async () => {
    render(<OfficerSubmitPage />);
    await act(async () => {});

    fireEvent.change(screen.getByLabelText(/Citizen's NIC/i), { target: { value: "200012345678" } });
    fireEvent.change(screen.getByLabelText(/Citizen's mobile/i), { target: { value: "0712345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText(/GPS location detected/i);

    mockUpdateDraft.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(mockUpdateDraft).toHaveBeenCalled());
    const [, fields] = mockUpdateDraft.mock.calls[0];
    expect(fields.district).toBeUndefined();
    expect(fields.ds_division).toBeUndefined();
  });

  it("stamps submitted_by_officer + officer_id, builds the PoC, and navigates on submit (AC4)", async () => {
    await walkToReview();
    fireEvent.click(screen.getByRole("button", { name: /Submit report/i }));

    await waitFor(() => expect(mockBuildPoC).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    const [record] = mockSubmit.mock.calls[0];
    expect(record.submitted_by_officer).toBe(true);
    expect(record.officer_id).toBe("officer-1");
    await waitFor(() => expect(push).toHaveBeenCalledWith("/officer/submit/poc"));
  });

  it("renders the receipt offline-first: submit navigates even when submitCaseOnline fails (CRITICAL #3)", async () => {
    mockSubmit.mockResolvedValue(null); // offline / 5xx
    await walkToReview();
    fireEvent.click(screen.getByRole("button", { name: /Submit report/i }));

    await waitFor(() => expect(mockBuildPoC).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/officer/submit/poc"));
  });

  it("discards a leftover COMPLETED draft on mount instead of reusing its offline_id (P1)", async () => {
    // A previous citizen's case already synced (canonical_id assigned) is still the "current"
    // draft id when the officer reopens this page for a NEW citizen without a reload.
    mockGetDraftId.mockReturnValue("prev-draft");
    mockGetCase.mockResolvedValue({
      offline_id: "prev-draft",
      case_category: "combined", // would wrongly seed classIdsRef with 2 classes if reused
      canonical_id: "HEC-2026-0001",
      sync_status: "synced",
    });
    render(<OfficerSubmitPage />);
    await act(async () => {});

    expect(mockClearDraftId).toHaveBeenCalledTimes(1);
    expect(mockClearOfficerPocMask).toHaveBeenCalledTimes(1);

    // Prove classIdsRef was NOT seeded from the stale "combined" draft: a single new photo's
    // rollup must be its own class, not unioned with the discarded draft's classes.
    fireEvent.change(screen.getByLabelText(/Citizen's NIC/i), { target: { value: "200012345678" } });
    fireEvent.change(screen.getByLabelText(/Citizen's mobile/i), { target: { value: "0712345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText(/GPS location detected/i);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("radiogroup", { name: /Damage category/i });
    fireEvent.click(screen.getByRole("radio", { name: /Crop Damage/i }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const input = await screen.findByTestId("submit-file-input");
    fireEvent.change(input, {
      target: { files: [new File(["x"], "damage.jpg", { type: "image/jpeg" })] },
    });
    await screen.findByTestId("ai-result-card");

    const [, fields] = (saveClassification as jest.Mock).mock.calls[0];
    expect(fields.case_category).toBe("property_damage"); // NOT "combined"
  });

  it("re-hydrates classIdsRef from an IN-PROGRESS (not yet submitted) draft as before", async () => {
    mockGetDraftId.mockReturnValue("mid-flow-draft");
    mockGetCase.mockResolvedValue({
      offline_id: "mid-flow-draft",
      case_category: "crop_damage", // in-progress — no canonical_id / sync_status yet
    });
    render(<OfficerSubmitPage />);
    await act(async () => {});

    expect(mockClearDraftId).not.toHaveBeenCalled();
    expect(mockClearOfficerPocMask).not.toHaveBeenCalled();
  });

  it("blocks the identity step and shows a re-login prompt when the officer session is missing (P2)", async () => {
    mockSession(null); // getSession() resolves with no session
    render(<OfficerSubmitPage />);
    await act(async () => {});

    expect(await screen.findByText(/officer session could not be verified/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Verifying|Continue/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Citizen's NIC/i), { target: { value: "200012345678" } });
    fireEvent.change(screen.getByLabelText(/Citizen's mobile/i), { target: { value: "0712345678" } });
    fireEvent.submit(screen.getByRole("button", { name: /Verifying|Continue/i }).closest("form")!);

    // never persists submitted_by_officer=true with a null officer_id
    expect(mockUpdateDraft).not.toHaveBeenCalled();
  });
});
