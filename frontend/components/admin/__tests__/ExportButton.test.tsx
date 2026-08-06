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
  mockDownloadExport.mockReset().mockResolvedValue("ok");
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
  mockDownloadExport.mockResolvedValue("error");
  render(<ExportButton filters={FILTERS} count={3} />);
  openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "export.csv" }));

  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("export.error"));
  expect(screen.getByRole("button", { name: /export\.button/ })).not.toBeDisabled();
});

it("redirects to login when the session has expired", async () => {
  mockDownloadExport.mockResolvedValue("unauthorized");
  render(<ExportButton filters={FILTERS} count={3} />);
  openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "export.csv" }));

  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/admin/login"));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("clears a previous error when a later export succeeds", async () => {
  mockDownloadExport.mockResolvedValueOnce("error").mockResolvedValueOnce("ok");
  render(<ExportButton filters={FILTERS} count={3} />);

  openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "export.csv" }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

  openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "export.csv" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
});

it("does not fire a second export while one is in flight", async () => {
  let release: (value: string) => void = () => {};
  mockDownloadExport.mockReturnValue(
    new Promise<string>((resolve) => {
      release = resolve;
    }),
  );

  render(<ExportButton filters={FILTERS} count={3} />);
  openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "export.csv" }));

  // While busy the trigger is disabled, so the menu cannot be reopened to fire a second one.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "export.exporting" })).toBeDisabled(),
  );

  release("ok");
  await waitFor(() => expect(mockDownloadExport).toHaveBeenCalledTimes(1));
});
