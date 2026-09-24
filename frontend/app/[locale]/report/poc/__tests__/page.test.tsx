import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PoCPage from "@/app/[locale]/report/poc/page";
import { getCase } from "@/lib/indexeddb";
import { getDraftId } from "@/lib/draft";
import { getAccessToken } from "@/lib/auth";
import { buildPoC, submitCaseOnline } from "@/lib/poc";
import { markCitizenSubmission } from "@/lib/citizenOutbox";

const replace = jest.fn();
const mockRouter = { replace };

jest.mock("@/navigation", () => ({
  useRouter: () => mockRouter,
  // The page now renders a "Done — Return Home" Link (the PoC screen is terminal and carries
  // no tab bar), so the navigation mock has to provide Link as well as useRouter.
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}));

jest.mock("@/hooks/useOnlineStatus", () => ({
  useOnlineStatus: () => ({ isOnline: true }),
}));

jest.mock("@/lib/draft", () => ({
  getDraftId: jest.fn(() => "draft-1"),
}));

jest.mock("@/lib/indexeddb", () => ({
  getCase: jest.fn(),
  updateDraft: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/auth", () => ({
  getAccessToken: jest.fn(),
}));

jest.mock("@/lib/citizenOutbox", () => ({
  markCitizenSubmission: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/poc", () => ({
  buildPoC: jest.fn(),
  submitCaseOnline: jest.fn().mockResolvedValue(null),
}));

const mockGetCase = getCase as jest.Mock;
const mockGetDraftId = getDraftId as jest.Mock;
const mockGetAccessToken = getAccessToken as jest.Mock;
const mockBuildPoC = buildPoC as jest.Mock;
const mockSubmit = submitCaseOnline as jest.Mock;

// offline_id matches the mocked draft id ("draft-1") throughout — in the real system the
// PoC's offline_id IS the draft's IndexedDB key (buildPoC reuses draft.offline_id when
// present), so this keeps the fixtures faithful to that invariant.
function pocRecord(overrides: Record<string, unknown> = {}) {
  return {
    offline_id: "draft-1",
    timestamp_local: "2026-07-07T10:00:00.000Z",
    gps: null,
    damage_category: "crop",
    submitter_identity_hash: "hash-1",
    sync_status: "pending",
    ...overrides,
  };
}

beforeEach(() => {
  replace.mockReset();
  mockGetDraftId.mockReset().mockReturnValue("draft-1");
  mockGetCase.mockReset();
  mockGetAccessToken.mockReset().mockResolvedValue(null);
  mockBuildPoC.mockReset();
  mockSubmit.mockReset().mockResolvedValue(null);
});

describe("PoCPage", () => {
  it("redirects to /report when there is no draft to render", async () => {
    mockGetDraftId.mockReturnValue(null);
    render(<PoCPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/report"));
  });

  it("renders the offline UUID as the reference before sync", async () => {
    mockGetCase.mockResolvedValue({ offline_id: "draft-1" });
    mockBuildPoC.mockResolvedValue(pocRecord());

    render(<PoCPage />);

    expect(await screen.findByText("draft-1")).toBeInTheDocument();
  });

  it("queues the report for automatic delivery before trying to send it", async () => {
    mockGetCase.mockResolvedValue({ offline_id: "draft-1" });
    mockBuildPoC.mockResolvedValue(pocRecord());
    render(<PoCPage />);
    await screen.findByText("draft-1");
    await waitFor(() => expect(markCitizenSubmission).toHaveBeenCalledWith("draft-1", expect.anything()));
  });

  it("does not re-queue a report the server already confirmed", async () => {
    mockGetCase.mockResolvedValue({ offline_id: "draft-1", canonical_id: "HEC-2026-0007" });
    (markCitizenSubmission as jest.Mock).mockClear();
    mockBuildPoC.mockResolvedValue(pocRecord({ sync_status: "synced" }));
    render(<PoCPage />);
    await screen.findByText("HEC-2026-0007");
    expect(markCitizenSubmission).not.toHaveBeenCalled();
  });

  it("shows the canonical id once the one-shot online submit succeeds", async () => {
    mockGetCase.mockResolvedValue({ offline_id: "draft-1" });
    mockBuildPoC.mockResolvedValue(pocRecord());
    mockGetAccessToken.mockResolvedValue("tok-1");
    mockSubmit.mockResolvedValue({ canonical_id: "HEC-2026-0007", offline_id: "draft-1" });

    render(<PoCPage />);

    expect(await screen.findByText("HEC-2026-0007")).toBeInTheDocument();
  });

  it("updates the canonical id live when a hec-case-synced event fires for this offline_id (Story 4.3)", async () => {
    mockGetCase.mockResolvedValue({ offline_id: "draft-1" });
    mockBuildPoC.mockResolvedValue(pocRecord());

    render(<PoCPage />);
    await screen.findByText("draft-1");
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
    mockGetCase.mockResolvedValue({ offline_id: "draft-1" });
    mockBuildPoC.mockResolvedValue(pocRecord());

    render(<PoCPage />);
    await screen.findByText("draft-1");

    fireEvent(
      window,
      new CustomEvent("hec-case-synced", {
        detail: { offline_id: "some-other-offline-id", canonical_id: "HEC-2026-9999" },
      }),
    );

    expect(screen.queryByText("HEC-2026-9999")).not.toBeInTheDocument();
  });

  // The defect behind "the reference on my downloaded receipt is wrong": the one-shot submit took
  // ~10 s against a remote database, and a receipt downloaded in that window carried the 36-char
  // offline UUID, which citizens then mistyped on the status page.
  it("while the HEC number may still arrive, says so and holds Download instead of showing the UUID", async () => {
    mockGetCase.mockResolvedValue({ offline_id: "draft-1" });
    mockBuildPoC.mockResolvedValue(pocRecord());
    mockGetAccessToken.mockResolvedValue("tok-1");
    let finish!: (v: unknown) => void;
    mockSubmit.mockReturnValue(new Promise((resolve) => (finish = resolve)));

    render(<PoCPage />);

    expect(await screen.findByText("assigningRef")).toBeInTheDocument();
    expect(screen.queryByText("draft-1")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "download" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "print" })).toBeDisabled();

    finish({ canonical_id: "HEC-2026-0007", offline_id: "draft-1" });

    expect(await screen.findByText("HEC-2026-0007")).toBeInTheDocument();
    expect(screen.queryByText("assigningRef")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "download" })).toBeEnabled();
  });

  it("when the submit fails, falls back to the offline id labelled as temporary, and allows saving it", async () => {
    mockGetCase.mockResolvedValue({ offline_id: "draft-1" });
    mockBuildPoC.mockResolvedValue(pocRecord());
    mockGetAccessToken.mockResolvedValue("tok-1");
    mockSubmit.mockResolvedValue(null);

    render(<PoCPage />);

    expect(await screen.findByText("draft-1")).toBeInTheDocument();
    expect(screen.getByText("temporaryLabel")).toBeInTheDocument();
    expect(screen.getByText("temporaryHint")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "download" })).toBeEnabled();
  });

  it("does not miss a hec-case-synced event that fires before the async draft/poc load resolves (review patch)", async () => {
    mockGetCase.mockResolvedValue({ offline_id: "draft-1" });
    let resolveBuildPoC!: (value: ReturnType<typeof pocRecord>) => void;
    mockBuildPoC.mockReturnValue(
      new Promise((resolve) => {
        resolveBuildPoC = resolve;
      }),
    );

    render(<PoCPage />);

    // Sync completes (and the event fires) WHILE buildPoC is still pending — i.e. before
    // `poc` state is set. The draftId ("draft-1" here) is known synchronously from mount,
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
});
