import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ExportButton } from "../ExportButton";
import { downloadExport } from "@/lib/adminExport";
import { getAccessToken } from "@/lib/auth";
import { EMPTY_FILTERS } from "../FilterBar";

// next-intl passthrough (Story 6.3 convention): the translator returns the key (+ interpolated
// values), so every assertion below targets an `admin.export.*` KEY, not English text.
jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, vars?: Record<string, unknown>) =>
      vars && Object.keys(vars).length ? `${key} ${Object.values(vars).join(" ")}` : key;
    t.rich = (key: string) => key;
    return t;
  },
  useLocale: () => "en",
}));

const mockReplace = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: (...a: unknown[]) => mockReplace(...a) }),
}));

jest.mock("@/lib/auth", () => ({ getAccessToken: jest.fn() }));
jest.mock("@/lib/adminExport", () => ({ downloadExport: jest.fn() }));

const mockGetAccessToken = getAccessToken as jest.Mock;
const mockDownloadExport = downloadExport as jest.Mock;

const FILTERS = { ...EMPTY_FILTERS, status: "Approved" };

beforeEach(() => {
  mockReplace.mockReset();
  mockGetAccessToken.mockReset().mockResolvedValue("tok-123");
  mockDownloadExport.mockReset().mockResolvedValue({ status: "ok" });
});

function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: /export\.button/ }));
}

it("labels the trigger with the case count", () => {
  render(<ExportButton filters={FILTERS} count={42} />);
  expect(screen.getByRole("button", { name: "export.button 42" })).toBeInTheDocument();
});

it("does not show the format menu until the trigger is clicked", () => {
  render(<ExportButton filters={FILTERS} count={3} />);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  openMenu();
  expect(screen.getByRole("menu")).toBeInTheDocument();
});

it("exports CSV with the current filters and the access token", async () => {
  render(<ExportButton filters={FILTERS} count={3} />);
  openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "export.csv" }));

  await waitFor(() => expect(mockDownloadExport).toHaveBeenCalledTimes(1));
  expect(mockDownloadExport).toHaveBeenCalledWith("tok-123", "csv", FILTERS);
});

it("exports PDF when the PDF option is chosen", async () => {
  render(<ExportButton filters={FILTERS} count={3} />);
  openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "export.pdf" }));

  await waitFor(() => expect(mockDownloadExport).toHaveBeenCalledTimes(1));
  expect(mockDownloadExport).toHaveBeenCalledWith("tok-123", "pdf", FILTERS);
});

it("closes the menu after a format is chosen", async () => {
  render(<ExportButton filters={FILTERS} count={3} />);
  openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "export.csv" }));
  await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
});

it("closes the menu on Escape without exporting", () => {
  render(<ExportButton filters={FILTERS} count={3} />);
  openMenu();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(mockDownloadExport).not.toHaveBeenCalled();
});

it("is disabled when the caller says so", () => {
  render(<ExportButton filters={FILTERS} count={0} disabled />);
  expect(screen.getByRole("button", { name: /export\.button/ })).toBeDisabled();
});

it("re-enables the trigger and reports an error when no token is available", async () => {
  // Regression guard: returning early here while still `busy` is the defect Story 5.5 shipped
  // (button stuck on its in-flight label forever).
  mockGetAccessToken.mockResolvedValue(null);
  render(<ExportButton filters={FILTERS} count={3} />);
  openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "export.csv" }));

  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("export.error"));
  expect(screen.getByRole("button", { name: /export\.button/ })).not.toBeDisabled();
  expect(mockDownloadExport).not.toHaveBeenCalled();
});

it("re-enables the trigger after a failed export", async () => {
  mockDownloadExport.mockResolvedValue({ status: "error" });
  render(<ExportButton filters={FILTERS} count={3} />);
  openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "export.csv" }));

  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("export.error"));
  expect(screen.getByRole("button", { name: /export\.button/ })).not.toBeDisabled();
});

it("redirects to login when the session has expired", async () => {
  mockDownloadExport.mockResolvedValue({ status: "unauthorized" });
  render(<ExportButton filters={FILTERS} count={3} />);
  openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "export.csv" }));

  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/admin/login"));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("clears a previous error when a later export succeeds", async () => {
  mockDownloadExport.mockResolvedValueOnce({ status: "error" }).mockResolvedValueOnce({ status: "ok" });
  render(<ExportButton filters={FILTERS} count={3} />);

  openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "export.csv" }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

  openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "export.csv" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
});

it("does not fire a second export when both menu items are clicked in the same batch", async () => {
  // Code review finding: the previous version clicked ONCE and only asserted the trigger was
  // disabled, so the guard itself was never exercised. This version does click twice.
  //
  // Honest limitation, verified rather than assumed: this test does NOT prove the ref-based
  // guard is better than the old state-based one — it passes against both. React Testing
  // Library wraps fireEvent in act(), which flushes the state update between the two clicks,
  // so the same-batch race the ref defends against cannot be reproduced here. The ref is kept
  // because it is correct in a real browser (where two clicks CAN land in one batch and both
  // read a stale `busy === false`), not because this test demonstrates it. What this test does
  // guarantee is the user-visible contract: two clicks produce exactly one export.
  let release: (value: { status: string }) => void = () => {};
  mockDownloadExport.mockReturnValue(
    new Promise<{ status: string }>((resolve) => {
      release = resolve;
    }),
  );

  render(<ExportButton filters={FILTERS} count={3} />);
  openMenu();

  const csv = screen.getByRole("menuitem", { name: "export.csv" });
  // Both dispatched before React can re-render and disable/unmount the menu.
  fireEvent.click(csv);
  fireEvent.click(csv);

  release({ status: "ok" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /export\.button/ })).not.toBeDisabled(),
  );
  expect(mockDownloadExport).toHaveBeenCalledTimes(1);
});

it("shows the in-flight label while exporting", async () => {
  let release: (value: { status: string }) => void = () => {};
  mockDownloadExport.mockReturnValue(
    new Promise<{ status: string }>((resolve) => {
      release = resolve;
    }),
  );

  render(<ExportButton filters={FILTERS} count={3} />);
  openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "export.csv" }));

  await waitFor(() =>
    expect(screen.getByRole("button", { name: "export.exporting" })).toBeDisabled(),
  );
  release({ status: "ok" });
  await waitFor(() => expect(mockDownloadExport).toHaveBeenCalledTimes(1));
});

it("warns the admin when the export was truncated", async () => {
  // All three review layers raised this: truncation was previously signalled only in the audit
  // log, which the admin never sees, so a capped PDF presented a partial total as authoritative.
  mockDownloadExport.mockResolvedValue({ status: "ok", truncated: true, rowCount: 2000 });
  render(<ExportButton filters={FILTERS} count={12000} />);
  openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "export.pdf" }));

  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("export.truncated 2000"),
  );
});

it("shows no truncation warning for a complete export", async () => {
  mockDownloadExport.mockResolvedValue({ status: "ok", truncated: false, rowCount: 3 });
  render(<ExportButton filters={FILTERS} count={3} />);
  openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "export.csv" }));

  await waitFor(() => expect(mockDownloadExport).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("reports a timed-out export distinctly from a generic failure", async () => {
  mockDownloadExport.mockResolvedValue({ status: "timeout" });
  render(<ExportButton filters={FILTERS} count={3} />);
  openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "export.csv" }));

  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("export.timeout"));
  expect(screen.getByRole("button", { name: /export\.button/ })).not.toBeDisabled();
});

it("clears a truncation warning on the next export", async () => {
  mockDownloadExport
    .mockResolvedValueOnce({ status: "ok", truncated: true, rowCount: 2000 })
    .mockResolvedValueOnce({ status: "ok", truncated: false });
  render(<ExportButton filters={FILTERS} count={3} />);

  openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "export.csv" }));
  await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());

  openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "export.csv" }));
  await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
});
