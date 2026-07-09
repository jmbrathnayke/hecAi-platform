import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import OfficerPoCPage from "@/app/officer/submit/poc/page";
import { getCase } from "@/lib/indexeddb";
import { buildPoC, submitCaseOnline } from "@/lib/poc";
import { enqueueCase } from "@/lib/syncQueue";
import { OFFICER_POC_NIC_KEY, clearOfficerPocMask } from "@/lib/officerPoc";
import { clearDraftId } from "@/lib/draft";
import { createClient } from "@/lib/supabase";

const push = jest.fn();
const replace = jest.fn();
// A stable object, matching Next.js's real useRouter() (memoized) — a fresh literal per
// call would change the page effect's `[router]` dependency on every state-driven
// re-render and re-run the whole submit/enqueue effect body multiple times per test.
const mockRouter = { push, replace };

jest.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
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
  buildCasePayload: jest.fn((record: Record<string, unknown>) => ({ ...record })),
  buildPoC: jest.fn(),
  submitCaseOnline: jest.fn().mockResolvedValue(null),
}));

jest.mock("@/lib/syncQueue", () => ({
  enqueueCase: jest.fn().mockResolvedValue(undefined),
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
const mockEnqueueCase = enqueueCase as jest.Mock;

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
  mockEnqueueCase.mockReset().mockResolvedValue(undefined);
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
    expect(mockEnqueueCase).not.toHaveBeenCalled();
  });

  it("queues the case for background sync when there is no session token (Story 4.1)", async () => {
    mockGetCase.mockResolvedValue({ offline_id: "draft-1", officer_id: "officer-42" });
    mockBuildPoC.mockResolvedValue(pocRecord());

    render(<OfficerPoCPage />);

    await waitFor(() => expect(mockEnqueueCase).toHaveBeenCalledTimes(1));
    expect(mockSubmit).not.toHaveBeenCalled();
    const [offlineId, payload] = mockEnqueueCase.mock.calls[0];
    expect(offlineId).toBe("draft-1");
    expect(payload).toMatchObject({ offline_id: "off-abc-123", submitted_by_officer: true, officer_id: "officer-42" });
  });

  it("queues the case for background sync when the one-shot online submit fails (Story 4.1)", async () => {
    (createClient as jest.Mock).mockReturnValueOnce({
      auth: { getSession: jest.fn().mockResolvedValue({ data: { session: { access_token: "tok-1" } } }) },
    });
    mockGetCase.mockResolvedValue({ offline_id: "draft-1", officer_id: "officer-42" });
    mockBuildPoC.mockResolvedValue(pocRecord());
    mockSubmit.mockResolvedValue(null);

    render(<OfficerPoCPage />);

    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockEnqueueCase).toHaveBeenCalledTimes(1));
    expect(mockEnqueueCase.mock.calls[0][0]).toBe("draft-1");
  });

  it("does not queue for background sync when the one-shot online submit succeeds", async () => {
    (createClient as jest.Mock).mockReturnValueOnce({
      auth: { getSession: jest.fn().mockResolvedValue({ data: { session: { access_token: "tok-1" } } }) },
    });
    mockGetCase.mockResolvedValue({ offline_id: "draft-1", officer_id: "officer-42" });
    mockBuildPoC.mockResolvedValue(pocRecord());
    mockSubmit.mockResolvedValue({ canonical_id: "HEC-2026-0009", offline_id: "off-abc-123" });

    render(<OfficerPoCPage />);

    expect(await screen.findByText("HEC-2026-0009")).toBeInTheDocument();
    expect(mockEnqueueCase).not.toHaveBeenCalled();
  });

  it("redirects to the submit flow when there is no draft to render", async () => {
    mockGetCase.mockResolvedValue(undefined);
    render(<OfficerPoCPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/officer/submit"));
  });

  it("updates the canonical id live when a hec-case-synced event fires for this offline_id (Story 4.3)", async () => {
    mockGetCase.mockResolvedValue({ offline_id: "draft-1", officer_id: "officer-42" });
    mockBuildPoC.mockResolvedValue(pocRecord());

    render(<OfficerPoCPage />);
    await waitFor(() => expect(mockEnqueueCase).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("HEC-2026-0042")).not.toBeInTheDocument();

    fireEvent(
      window,
      new CustomEvent("hec-case-synced", {
        detail: { offline_id: "draft-1", canonical_id: "HEC-2026-0042" },
      }),
    );

    expect(await screen.findByText("HEC-2026-0042")).toBeInTheDocument();
  });

  it("ignores a hec-case-synced event for a different offline_id (Story 4.3)", async () => {
    mockGetCase.mockResolvedValue({ offline_id: "draft-1", officer_id: "officer-42" });
    mockBuildPoC.mockResolvedValue(pocRecord());

    render(<OfficerPoCPage />);
    await waitFor(() => expect(mockEnqueueCase).toHaveBeenCalledTimes(1));

    fireEvent(
      window,
      new CustomEvent("hec-case-synced", {
        detail: { offline_id: "some-other-offline-id", canonical_id: "HEC-2026-9999" },
      }),
    );

    expect(screen.queryByText("HEC-2026-9999")).not.toBeInTheDocument();
  });

  it("does not miss a hec-case-synced event that fires before the async draft/poc load resolves (review patch)", async () => {
    mockGetCase.mockResolvedValue({ offline_id: "draft-1", officer_id: "officer-42" });
    let resolveBuildPoC!: (value: ReturnType<typeof pocRecord>) => void;
    mockBuildPoC.mockReturnValue(
      new Promise((resolve) => {
        resolveBuildPoC = resolve;
      }),
    );

    render(<OfficerPoCPage />);

    // Sync completes (and the event fires) WHILE buildPoC is still pending — i.e. before
    // `poc` state is set. The draftId ("draft-1") is known synchronously from mount,
    // independent of how long the async draft/poc chain takes.
    fireEvent(
      window,
      new CustomEvent("hec-case-synced", {
        detail: { offline_id: "draft-1", canonical_id: "HEC-2026-0042" },
      }),
    );

    resolveBuildPoC(pocRecord());

    expect(await screen.findByText("HEC-2026-0042")).toBeInTheDocument();
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
