/**
 * Story 8.6 — the payment authorisation panel.
 *
 * This is the only component in the app that ever renders a full bank account number, so most of
 * these are about when it does NOT.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PaymentAuthorizationPanel } from "@/components/PaymentAuthorizationPanel";
import { authorizePayment } from "@/lib/dsCases";

jest.mock("@/lib/dsCases", () => ({ authorizePayment: jest.fn() }));

const mockAuthorize = authorizePayment as jest.Mock;
const t = (k: string) => k;
const onClose = jest.fn();

const ACCOUNT = "8001234567890";

const AUTH = {
  canonical_id: "HEC-2026-0001",
  household_ref: "HH-2026-0001",
  amount_lkr: 40000,
  authorized_at: "2026-08-26T12:00:00",
  bank_details: {
    account_number: ACCOUNT,
    bank_name: "Bank of Ceylon",
    branch: "Thalawa",
    account_holder: "Test Registrant",
  },
};

function panel() {
  return render(
    <PaymentAuthorizationPanel canonicalId="HEC-2026-0001" t={t} onClose={onClose} />,
  );
}

beforeEach(() => {
  onClose.mockReset();
  mockAuthorize.mockReset().mockResolvedValue({ ok: true, authorization: AUTH });
});

describe("the account number is not shown until it is asked for", () => {
  it("does not fetch or render anything sensitive on mount", () => {
    panel();
    // Rendering on mount would mean a reveal — and an audit row — every time a case was opened,
    // including by accident.
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(screen.queryByText(ACCOUNT)).not.toBeInTheDocument();
    expect(screen.queryByTestId("bank-details")).not.toBeInTheDocument();
  });

  it("warns that the reveal is recorded BEFORE the officer clicks", () => {
    panel();
    expect(screen.getByText("payment.warning")).toBeInTheDocument();
  });

  it("reveals the account only after the deliberate click", async () => {
    panel();
    fireEvent.click(screen.getByText("payment.reveal"));
    expect(await screen.findByText(ACCOUNT)).toBeInTheDocument();
    expect(mockAuthorize).toHaveBeenCalledWith("HEC-2026-0001");
  });

  it("shows the rest of the account details alongside it", async () => {
    panel();
    fireEvent.click(screen.getByText("payment.reveal"));
    await screen.findByTestId("bank-details");
    expect(screen.getByText("Bank of Ceylon")).toBeInTheDocument();
    expect(screen.getByText("Thalawa")).toBeInTheDocument();
    expect(screen.getByText("Rs. 40,000")).toBeInTheDocument();
  });

  it("hides the reveal button once revealed, so a second click cannot re-trigger it", async () => {
    panel();
    fireEvent.click(screen.getByText("payment.reveal"));
    await screen.findByTestId("bank-details");
    expect(screen.queryByText("payment.reveal")).not.toBeInTheDocument();
  });

  it("does not fire twice while a reveal is in flight", async () => {
    // A double-click must not produce two reveals, i.e. two audit rows for one intent.
    let resolve: (v: unknown) => void = () => {};
    mockAuthorize.mockReturnValue(new Promise((r) => (resolve = r)));
    panel();

    fireEvent.click(screen.getByText("payment.reveal"));
    // The button relabels and disables while the request is in flight.
    const busyButton = await screen.findByText("payment.revealing");
    fireEvent.click(busyButton);
    expect(mockAuthorize).toHaveBeenCalledTimes(1);

    resolve({ ok: true, authorization: AUTH });
    await screen.findByTestId("bank-details");
    expect(mockAuthorize).toHaveBeenCalledTimes(1);
  });
});

describe("refusals are told apart, because each has a different fix", () => {
  it.each([
    ["not-approved", "payment.error.notApproved"],
    ["no-household", "payment.error.noHousehold"],
    ["no-bank-details", "payment.error.noBankDetails"],
    ["unreadable", "payment.error.unreadable"],
    ["not-found", "payment.error.notFound"],
    ["network", "payment.error.network"],
  ])("%s renders its own message", async (reason, key) => {
    mockAuthorize.mockResolvedValue({ ok: false, failure: { reason } });
    panel();
    fireEvent.click(screen.getByText("payment.reveal"));
    expect(await screen.findByText(key)).toBeInTheDocument();
    expect(screen.queryByTestId("bank-details")).not.toBeInTheDocument();
  });

  it("never says 'the family gave no details' when the ciphertext is unreadable", async () => {
    // That message would send the officer to collect details the family already provided.
    mockAuthorize.mockResolvedValue({ ok: false, failure: { reason: "unreadable" } });
    panel();
    fireEvent.click(screen.getByText("payment.reveal"));
    await screen.findByText("payment.error.unreadable");
    expect(screen.queryByText("payment.error.noBankDetails")).not.toBeInTheDocument();
  });

  it("shows no account number on any failure", async () => {
    mockAuthorize.mockResolvedValue({ ok: false, failure: { reason: "server", status: 500, code: "x" } });
    panel();
    fireEvent.click(screen.getByText("payment.reveal"));
    await screen.findByText("payment.error.server");
    expect(screen.queryByText(ACCOUNT)).not.toBeInTheDocument();
  });

  it("lets the officer retry after a network failure", async () => {
    mockAuthorize.mockResolvedValue({ ok: false, failure: { reason: "network" } });
    panel();
    fireEvent.click(screen.getByText("payment.reveal"));
    await screen.findByText("payment.error.network");
    // The button is still there — a transport failure revealed nothing, so trying again is safe.
    fireEvent.click(screen.getByText("payment.reveal"));
    await waitFor(() => expect(mockAuthorize).toHaveBeenCalledTimes(2));
  });
});

it("closes without revealing anything", () => {
  panel();
  fireEvent.click(screen.getByText("payment.close"));
  expect(onClose).toHaveBeenCalled();
  expect(mockAuthorize).not.toHaveBeenCalled();
});
