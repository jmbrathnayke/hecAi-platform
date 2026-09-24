import { authorizePayment, recordFinalDecision } from "@/lib/dsCases";
import { getAccessToken } from "@/lib/auth";

jest.mock("@/lib/auth", () => ({ getAccessToken: jest.fn() }));

const mockToken = getAccessToken as jest.Mock;
const fetchMock = jest.fn();

function reply(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  mockToken.mockReset().mockResolvedValue("tok");
  fetchMock.mockReset();
  global.fetch = fetchMock;
});

it("posts the amount and reason to the case's final-decision endpoint", async () => {
  fetchMock.mockResolvedValue(reply(200, {
    canonical_id: "HEC-2026-0010",
    final_decision: { amount_lkr: 40000, reason: "Adjusted after inspection.", decided_at: "x", is_final_decision: true, revised: false, unchanged: false },
    ai_estimate_lkr: 45000,
    dwc_approved_amount_lkr: 42000,
  }));
  const res = await recordFinalDecision("HEC-2026-0010", 40000, "Adjusted after inspection.");
  expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/v1\/ds\/cases\/HEC-2026-0010\/final-decision$/);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ amount_lkr: 40000, reason: "Adjusted after inspection." });
  expect(res).toMatchObject({ ok: true, aiEstimate: 45000, dwcAmount: 42000, decision: { amount_lkr: 40000 } });
});

it.each([
  [400, { error: "reason_required" }, { reason: "reason-required" }],
  [400, { error: "invalid_amount" }, { reason: "invalid-amount" }],
  [409, { error: "not_approved", status: "Submitted" }, { reason: "not-approved", status: "Submitted" }],
  [409, { error: "payment_already_authorized" }, { reason: "payment-authorized" }],
  [409, { error: "no_payment_authorization" }, { reason: "no-payment-record" }],
  [404, { error: "not_found" }, { reason: "not-found" }],
  [403, { error: "forbidden" }, { reason: "forbidden" }],
])("maps HTTP %i %j", async (status, body, failure) => {
  fetchMock.mockResolvedValue(reply(status, body));
  await expect(recordFinalDecision("HEC-2026-0010", 1, null)).resolves.toEqual({ ok: false, failure });
});

it("payment before the final decision is its own, explained refusal", async () => {
  fetchMock.mockResolvedValue(reply(409, { error: "final_decision_required" }));
  await expect(authorizePayment("HEC-2026-0010")).resolves.toEqual({
    ok: false,
    failure: { reason: "final-decision-required" },
  });
});
