import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import StatusPage from "@/app/[locale]/status/page";

jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }));
jest.mock("next/dynamic", () => () => () => null);
jest.mock("@/components/StatusCard", () => ({
  StatusCard: ({ canonical_id }: { canonical_id: string }) => <p>card {canonical_id}</p>,
}));

const fetchMock = jest.fn();

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue({
    status: 200,
    ok: true,
    json: async () => ({ canonical_id: "HEC-2026-0281", offline_id: "x", status: "Submitted", updated_at: null }),
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

it.each([" HEC-2026-0281 ", "HEC-2026- 0281", "HEC -2026-0281"])(
  "looks up %p as HEC-2026-0281: whitespace is a transcription slip, not part of a reference",
  async (typed) => {
    render(<StatusPage />);
    fireEvent.change(screen.getByLabelText("inputLabel"), { target: { value: typed } });
    fireEvent.click(screen.getByText("check"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/v1\/cases\/status\/HEC-2026-0281$/);
    expect(await screen.findByText("card HEC-2026-0281")).toBeInTheDocument();
  },
);

it("still refuses a reference that is malformed once spaces are removed, without a request", async () => {
  render(<StatusPage />);
  fireEvent.change(screen.getByLabelText("inputLabel"), { target: { value: "HEC-2026-O281" } });
  fireEvent.click(screen.getByText("check"));
  expect(await screen.findByRole("alert")).toHaveTextContent("notFound");
  expect(fetchMock).not.toHaveBeenCalled();
});
