import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import OfficerSubmitPage from "@/app/officer/submit/page";
import { encryptField } from "@/lib/crypto";

// next-intl passthrough (Story 6.2): translator returns the key (+ interpolation values, + rich).
// Covers officer + report namespaces and the DistrictPicker/AIResultCard/OverrideForm children.
jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, vars?: Record<string, unknown>) =>
      vars && Object.keys(vars).length ? `${key} ${Object.values(vars).join(" ")}` : key;
    t.rich = (key: string) => key;
    return t;
  },
  useLocale: () => "en",
}));
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

// Story 8.5: the identity step now resolves the citizen's household before it will advance —
// the officer app cannot derive a household_ref itself (it encrypts the NIC with a
// non-extractable device key), so this call is the only way it gets one. Default to found;
// the dedicated tests below override it.
jest.mock("@/lib/households", () => ({ lookupHousehold: jest.fn() }));

jest.mock("@/lib/mobilenet", () => ({ classifyImage: jest.fn() }));
jest.mock("@/lib/imageQuality", () => ({ assessImageQuality: jest.fn() }));
jest.mock("@/lib/geolocation", () => ({ getCurrentPosition: jest.fn() }));

import { lookupHousehold } from "@/lib/households";

const mockLookupHousehold = lookupHousehold as jest.Mock;

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
  mockLookupHousehold.mockReset().mockResolvedValue({
    status: "found",
    household: {
      household_ref: "HH-2026-0001",
      district: "අනුරාධපුරය",
      ds_division: "තලාව",
    },
  });
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

// The mockup's photo strip / counter are driven by object URLs, and jsdom implements neither
// createObjectURL nor revokeObjectURL. addThumbnail() swallows the resulting TypeError by design,
// which would make the strip assertions below pass vacuously — so stub both.
let objectUrlSeq = 0;
beforeEach(() => {
  objectUrlSeq = 0;
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = jest.fn(
    () => `blob:photo-${++objectUrlSeq}`,
  );
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = jest.fn();
});

// Drives the flow from the identity step through to the classify step, stopping with the camera
// (and its gallery fallback input) on screen.
async function walkToClassify() {
  render(<OfficerSubmitPage />);
  await act(async () => {});

  fireEvent.change(screen.getByLabelText(/submit.citizenNic/i), { target: { value: "200012345678" } });
  fireEvent.change(screen.getByLabelText(/submit.citizenMobile/i), { target: { value: "0712345678" } });
  fireEvent.click(screen.getByRole("button", { name: "submit.continue" }));

  await screen.findByText(/submit.gpsDetected/i);
  fireEvent.click(screen.getByRole("button", { name: "submit.continue" }));

  await screen.findByRole("radiogroup", { name: /submit.damageCategoryGroup/i });
  fireEvent.click(screen.getByRole("radio", { name: /step3.crop/i }));
  fireEvent.click(screen.getByRole("button", { name: "submit.continue" }));

  return screen.findByTestId("submit-file-input");
}

function capturePhoto(input: HTMLElement) {
  fireEvent.change(input, {
    target: { files: [new File(["x"], "damage.jpg", { type: "image/jpeg" })] },
  });
}

// Drives the flow from the identity step through to the review step.
async function walkToReview() {
  render(<OfficerSubmitPage />);
  // let the session effect (officer_id/token) resolve
  await act(async () => {});

  // Identity
  fireEvent.change(screen.getByLabelText(/submit.citizenNic/i), { target: { value: "200012345678" } });
  fireEvent.change(screen.getByLabelText(/submit.citizenMobile/i), { target: { value: "0712345678" } });
  fireEvent.click(screen.getByRole("button", { name: "submit.continue" }));

  // Location (GPS resolves → Continue)
  await screen.findByText(/submit.gpsDetected/i);
  fireEvent.click(screen.getByRole("button", { name: "submit.continue" }));

  // Damage
  await screen.findByRole("radiogroup", { name: /submit.damageCategoryGroup/i });
  fireEvent.click(screen.getByRole("radio", { name: /step3.crop/i }));
  fireEvent.click(screen.getByRole("button", { name: "submit.continue" }));

  // Classify
  const input = await screen.findByTestId("submit-file-input");
  fireEvent.change(input, {
    target: { files: [new File(["x"], "damage.jpg", { type: "image/jpeg" })] },
  });
  await screen.findByTestId("ai-result-card");
  fireEvent.click(screen.getByRole("button", { name: "aiResult.accept" }));
  fireEvent.click(await screen.findByRole("button", { name: /submit.reviewAndSubmit/i }));

  await screen.findByRole("button", { name: /submit.submit/i });
}

describe("OfficerSubmitPage", () => {
  it("encrypts the citizen NIC + mobile and stores ciphertext (never plaintext) on the draft (AC2)", async () => {
    render(<OfficerSubmitPage />);
    await act(async () => {});

    fireEvent.change(screen.getByLabelText(/submit.citizenNic/i), { target: { value: "200012345678" } });
    fireEvent.change(screen.getByLabelText(/submit.citizenMobile/i), { target: { value: "0712345678" } });
    fireEvent.click(screen.getByRole("button", { name: "submit.continue" }));

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
    fireEvent.change(screen.getByLabelText(/submit.citizenNic/i), { target: { value: "200012345678" } });
    fireEvent.change(screen.getByLabelText(/submit.citizenMobile/i), { target: { value: "0712345678" } });
    fireEvent.click(screen.getByRole("button", { name: "submit.continue" }));
    await screen.findByText(/submit.gpsDetected/i);
    fireEvent.click(screen.getByRole("button", { name: "submit.continue" }));
    await screen.findByRole("radiogroup", { name: /submit.damageCategoryGroup/i });
    fireEvent.click(screen.getByRole("radio", { name: /step3.crop/i }));
    fireEvent.click(screen.getByRole("button", { name: "submit.continue" }));

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

    fireEvent.change(screen.getByLabelText(/submit.citizenNic/i), { target: { value: "200012345678" } });
    fireEvent.change(screen.getByLabelText(/submit.citizenMobile/i), { target: { value: "0712345678" } });
    fireEvent.click(screen.getByRole("button", { name: "submit.continue" }));
    await screen.findByText(/submit.gpsDetected/i);

    const districtSelect = screen.getByLabelText("submit.districtLabel") as HTMLSelectElement;
    const district = districtSelect.options[1].value;
    fireEvent.change(districtSelect, { target: { value: district } });
    const divisionSelect = screen.getByLabelText("submit.dsDivisionLabel") as HTMLSelectElement;
    const division = divisionSelect.options[1].value;
    fireEvent.change(divisionSelect, { target: { value: division } });

    mockUpdateDraft.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "submit.continue" }));

    await waitFor(() => expect(mockUpdateDraft).toHaveBeenCalled());
    const [, fields] = mockUpdateDraft.mock.calls[0];
    expect(fields.district).toBe(district);
    expect(fields.ds_division).toBe(division);
  });

  it("leaves district/ds_division undefined on the draft when the picker is left untouched", async () => {
    render(<OfficerSubmitPage />);
    await act(async () => {});

    fireEvent.change(screen.getByLabelText(/submit.citizenNic/i), { target: { value: "200012345678" } });
    fireEvent.change(screen.getByLabelText(/submit.citizenMobile/i), { target: { value: "0712345678" } });
    fireEvent.click(screen.getByRole("button", { name: "submit.continue" }));
    await screen.findByText(/submit.gpsDetected/i);

    mockUpdateDraft.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "submit.continue" }));

    await waitFor(() => expect(mockUpdateDraft).toHaveBeenCalled());
    const [, fields] = mockUpdateDraft.mock.calls[0];
    expect(fields.district).toBeUndefined();
    expect(fields.ds_division).toBeUndefined();
  });

  it("stamps submitted_by_officer + officer_id, builds the PoC, and navigates on submit (AC4)", async () => {
    await walkToReview();
    fireEvent.click(screen.getByRole("button", { name: /submit.submit/i }));

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
    fireEvent.click(screen.getByRole("button", { name: /submit.submit/i }));

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
    fireEvent.change(screen.getByLabelText(/submit.citizenNic/i), { target: { value: "200012345678" } });
    fireEvent.change(screen.getByLabelText(/submit.citizenMobile/i), { target: { value: "0712345678" } });
    fireEvent.click(screen.getByRole("button", { name: "submit.continue" }));
    await screen.findByText(/submit.gpsDetected/i);
    fireEvent.click(screen.getByRole("button", { name: "submit.continue" }));
    await screen.findByRole("radiogroup", { name: /submit.damageCategoryGroup/i });
    fireEvent.click(screen.getByRole("radio", { name: /step3.crop/i }));
    fireEvent.click(screen.getByRole("button", { name: "submit.continue" }));
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

    expect(await screen.findByText(/submit.sessionError/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /submit.verifyingSession|submit.continue/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/submit.citizenNic/i), { target: { value: "200012345678" } });
    fireEvent.change(screen.getByLabelText(/submit.citizenMobile/i), { target: { value: "0712345678" } });
    fireEvent.submit(screen.getByRole("button", { name: /submit.verifyingSession|submit.continue/i }).closest("form")!);

    // never persists submitted_by_officer=true with a null officer_id
    expect(mockUpdateDraft).not.toHaveBeenCalled();
  });
});

// officer-camera.html: step bar with dots, in-app camera, "N of 10 photos taken", photo strip,
// field notes carried into the review summary.
describe("OfficerSubmitPage — camera screen chrome", () => {
  it("shows the mockup's 5-dot step rail and advances it with the officer", async () => {
    render(<OfficerSubmitPage />);
    await act(async () => {});

    const bar = screen.getByTestId("officer-top-bar");
    const dotStates = () =>
      Array.from(bar.querySelectorAll("[data-state]")).map((el) => el.getAttribute("data-state"));

    // The heading carries the progress in words; the dots only mirror it (they are aria-hidden).
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("submit.step1");
    expect(dotStates()).toEqual(["active", "upcoming", "upcoming", "upcoming", "upcoming"]);

    fireEvent.change(screen.getByLabelText(/submit.citizenNic/i), { target: { value: "200012345678" } });
    fireEvent.change(screen.getByLabelText(/submit.citizenMobile/i), { target: { value: "0712345678" } });
    fireEvent.click(screen.getByRole("button", { name: "submit.continue" }));

    await screen.findByText(/submit.gpsDetected/i);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("submit.step2");
    expect(dotStates()).toEqual(["done", "active", "upcoming", "upcoming", "upcoming"]);

    fireEvent.click(screen.getByRole("button", { name: "submit.continue" }));
    await screen.findByRole("radiogroup", { name: /submit.damageCategoryGroup/i });
    expect(dotStates()).toEqual(["done", "done", "active", "upcoming", "upcoming"]);
  });

  it("puts the camera and the photo counter on the classify step, and a way back to damage", async () => {
    await walkToClassify();

    expect(screen.getByTestId("camera-capture")).toBeInTheDocument();
    expect(screen.getByText("camera.count 0 10")).toBeInTheDocument();
    expect(screen.queryByTestId("photo-strip")).not.toBeInTheDocument();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("submit.step4");

    // The camera is full-bleed and this step has no Continue/Back of its own, so the camera's
    // back affordance is the only route to the damage step — and it must survive jsdom's
    // missing mediaDevices, i.e. any device where the camera never comes up.
    fireEvent.click(screen.getByRole("button", { name: "camera.back" }));
    expect(await screen.findByRole("radiogroup", { name: /submit.damageCategoryGroup/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("submit.step3");
  });

  it("banks each capture into the photo strip and the running count", async () => {
    const input = await walkToClassify();

    capturePhoto(input);
    await screen.findByTestId("ai-result-card");

    expect(screen.getByTestId("photo-strip")).toBeInTheDocument();
    expect(screen.getByText("classify.photosCaptured 1")).toBeInTheDocument();
    expect(screen.getByText("camera.count 1 10")).toBeInTheDocument();
  });

  it("carries a saved field note into the review summary", async () => {
    const note = "Approx 1.5 acres of paddy affected, east section of field.";
    const input = await walkToClassify();
    capturePhoto(input);
    await screen.findByTestId("ai-result-card");

    fireEvent.change(screen.getByTestId("field-notes"), { target: { value: note } });
    // The review step mirrors only what actually landed in the draft, so wait for the debounced
    // write rather than for the keystroke.
    await waitFor(
      () => expect(mockUpdateDraft).toHaveBeenCalledWith("draft-1", { field_notes: note }),
      { timeout: 2000 },
    );

    fireEvent.click(screen.getByRole("button", { name: "aiResult.accept" }));
    fireEvent.click(await screen.findByRole("button", { name: /submit.reviewAndSubmit/i }));

    expect(await screen.findByText("submit.reviewNotes")).toBeInTheDocument();
    expect(screen.getByText(note)).toBeInTheDocument();
  });

  it("omits the notes row entirely when the officer wrote none", async () => {
    await walkToReview();
    expect(screen.queryByText("submit.reviewNotes")).not.toBeInTheDocument();
  });

  it("does not send the field note to the server — it is draft-local for now", async () => {
    const note = "east section, standing water";
    const input = await walkToClassify();
    capturePhoto(input);
    await screen.findByTestId("ai-result-card");

    fireEvent.change(screen.getByTestId("field-notes"), { target: { value: note } });
    await waitFor(
      () => expect(mockUpdateDraft).toHaveBeenCalledWith("draft-1", { field_notes: note }),
      { timeout: 2000 },
    );

    fireEvent.click(screen.getByRole("button", { name: "aiResult.accept" }));
    fireEvent.click(await screen.findByRole("button", { name: /submit.reviewAndSubmit/i }));
    fireEvent.click(await screen.findByRole("button", { name: /submit.submit/i }));

    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    // buildCasePayload is an explicit allowlist and has no field_notes member; this pins that
    // fact so the gap is noticed if a payload field is ever added without a backend column.
    const [record] = mockSubmit.mock.calls[0];
    expect(record).not.toHaveProperty("field_notes");
    expect(JSON.stringify(record)).not.toContain(note);
  });
});

// --- Story 8.5: the FR-10.3 gate on the officer-assisted path -------------------------------
//
// The officer is standing with the citizen and their card. Resolving the household at the
// identity step means an unregistered family is found out in the first seconds — not after the
// officer has photographed the damage and walked away, which is what a bare 403 at submit time
// would cost.

async function fillIdentityAndContinue() {
  render(<OfficerSubmitPage />);
  await act(async () => {});
  fireEvent.change(screen.getByLabelText(/submit.citizenNic/i), {
    target: { value: "200012345678" },
  });
  fireEvent.change(screen.getByLabelText(/submit.citizenMobile/i), {
    target: { value: "0712345678" },
  });
  fireEvent.click(screen.getByRole("button", { name: "submit.continue" }));
  await act(async () => {});
}

it("looks the household up from the NIC the officer typed", async () => {
  await fillIdentityAndContinue();
  expect(mockLookupHousehold).toHaveBeenCalledWith("200012345678");
});

it("stores the household reference on the draft, and never the NIC", async () => {
  await fillIdentityAndContinue();
  const [, fields] = mockUpdateDraft.mock.calls.at(-1)!;
  expect(fields.household_ref).toBe("HH-2026-0001");
  // The NIC itself stays encrypted, exactly as before Epic 8.
  expect(JSON.stringify(fields)).not.toContain("200012345678");
});

it("blocks at the identity step when the family is not registered", async () => {
  mockLookupHousehold.mockResolvedValue({ status: "not-registered" });
  await fillIdentityAndContinue();
  expect(screen.getByText("submit.householdNotRegistered")).toBeInTheDocument();
  // Still on identity — the officer has not been walked into the location step.
  expect(screen.getByLabelText(/submit.citizenNic/i)).toBeInTheDocument();
  expect(mockUpdateDraft).not.toHaveBeenCalled();
});

it("does NOT say 'not registered' when the lookup itself failed", async () => {
  // On a network blip that message would send a properly registered family to the DS office to
  // fix nothing at all.
  mockLookupHousehold.mockResolvedValue({ status: "error" });
  await fillIdentityAndContinue();
  expect(screen.getByText("submit.householdLookupFailed")).toBeInTheDocument();
  expect(screen.queryByText("submit.householdNotRegistered")).not.toBeInTheDocument();
});

it("does not look up an invalid NIC", async () => {
  render(<OfficerSubmitPage />);
  await act(async () => {});
  fireEvent.change(screen.getByLabelText(/submit.citizenNic/i), { target: { value: "junk" } });
  fireEvent.change(screen.getByLabelText(/submit.citizenMobile/i), {
    target: { value: "0712345678" },
  });
  fireEvent.click(screen.getByRole("button", { name: "submit.continue" }));
  await act(async () => {});
  expect(mockLookupHousehold).not.toHaveBeenCalled();
});
