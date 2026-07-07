import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import OfficerPoCPage from "@/app/officer/submit/poc/page";
import { getCase } from "@/lib/indexeddb";
import { buildPoC, submitCaseOnline } from "@/lib/poc";
import { OFFICER_POC_NIC_KEY, clearOfficerPocMask } from "@/lib/officerPoc";
import { clearDraftId } from "@/lib/draft";

const push = jest.fn();
const replace = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
}));

jest.mock("@/lib/draft", () => ({
  getDraftId: jest.fn(() => "draft-1"),
  clearDraftId: jest.fn(),
}));

jest.mock("@/lib/officerPoc", () => ({
  OFFICER_POC_NIC_KEY: "hec-officer-poc-nic-last4",
  clearOfficerPocMask: jest.fn(),
}));

jest.mock("@/lib/indexeddb", () => ({
  getCase: jest.fn(),
  updateDraft: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/poc", () => ({
  buildPoC: jest.fn(),
  submitCaseOnline: jest.fn().mockResolvedValue(null),
}));

jest.mock("@/lib/supabase", () => ({
  createClient: jest.fn(() => ({
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
    },
  })),
}));

const mockGetCase = getCase as jest.Mock;
const mockBuildPoC = buildPoC as jest.Mock;
const mockSubmit = submitCaseOnline as jest.Mock;

function pocRecord(overrides: Record<string, unknown> = {}) {
  return {
    offline_id: "off-abc-123",
    timestamp_local: "2026-07-07T10:00:00.000Z",
    gps: null,
    damage_category: "crop",
    submitter_identity_hash: "hash-1",
    sync_status: "pending",
    ...overrides,
  };
}

beforeEach(() => {
  push.mockReset();
  replace.mockReset();
  (clearDraftId as jest.Mock).mockReset();
  (clearOfficerPocMask as jest.Mock).mockReset();
  mockGetCase.mockReset();
  mockBuildPoC.mockReset();
  mockSubmit.mockReset().mockResolvedValue(null);
  try {
    sessionStorage.clear();
  } catch {}
});

describe("OfficerPoCPage", () => {
  it("masks the citizen NIC to its last 4 chars, shows the officer badge, and QRs the offline_id (AC6)", async () => {
    sessionStorage.setItem(OFFICER_POC_NIC_KEY, "678V");
    mockGetCase.mockResolvedValue({ offline_id: "draft-1", officer_id: "officer-42" });
    mockBuildPoC.mockResolvedValue(pocRecord());

    const { container } = render(<OfficerPoCPage />);

    // NIC masked to last-4 only
    const mask = await screen.findByTestId("citizen-nic-mask");
    expect(mask).toHaveTextContent("678V");
    expect(mask.textContent).not.toContain("200012345"); // no full plaintext ever shown

    // officer badge
    expect(screen.getByTestId("officer-badge")).toHaveTextContent("officer-42");

    // QR encodes the offline_id (PoCCard renders the QR + the offline_id as the reference)
    expect(container.querySelector("#poc-qr svg")).toBeInTheDocument();
    expect(screen.getByText("off-abc-123")).toBeInTheDocument();
  });

  it("shows the canonical HEC id only once synced", async () => {
    mockGetCase.mockResolvedValue({
      offline_id: "draft-1",
      officer_id: "officer-42",
      canonical_id: "HEC-2026-0007",
    });
    mockBuildPoC.mockResolvedValue(pocRecord());

    render(<OfficerPoCPage />);

    expect(await screen.findByText("HEC-2026-0007")).toBeInTheDocument();
    // already synced → no further online submit attempt
    await waitFor(() => expect(mockSubmit).not.toHaveBeenCalled());
  });

  it("redirects to the submit flow when there is no draft to render", async () => {
    mockGetCase.mockResolvedValue(undefined);
    render(<OfficerPoCPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/officer/submit"));
  });

  it("'Submit another citizen' clears the draft + NIC mask before navigating (P1/P3)", async () => {
    mockGetCase.mockResolvedValue({ offline_id: "draft-1", officer_id: "officer-42" });
    mockBuildPoC.mockResolvedValue(pocRecord());
    render(<OfficerPoCPage />);

    const button = await screen.findByRole("button", { name: /Submit another citizen/i });
    fireEvent.click(button);

    expect(clearDraftId as jest.Mock).toHaveBeenCalledTimes(1);
    expect(clearOfficerPocMask as jest.Mock).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/officer/submit");
  });
});
