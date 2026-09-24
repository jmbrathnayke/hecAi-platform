import { setHouseholdBankDetails } from "@/lib/dsCases";
import { getAccessToken } from "@/lib/auth";

jest.mock("@/lib/auth", () => ({ getAccessToken: jest.fn() }));

const mockToken = getAccessToken as jest.Mock;
const fetchMock = jest.fn();
const originalEnv = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
};

const BANK = { account_number: "7009876543210", bank_name: "People's Bank" };
const REASON = "Account closed; family brought a new passbook.";

function respond(status: number, body: unknown) {
  fetchMock.mockResolvedValue({ status, ok: status >= 200 && status < 300, json: async () => body });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  mockToken.mockReset().mockResolvedValue("tok-1");
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  // A Jest worker runs other test files in the same process; leave the environment as found.
  if (originalEnv.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = originalEnv.url;
  if (originalEnv.key === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalEnv.key;
});

it("PUTs the account and its reason to the household's own endpoint", async () => {
  respond(200, { household_ref: "HH-2026-0001", bank_account_last4: "3210", replaced_existing: true });
  const result = await setHouseholdBankDetails("HH-2026-0001", BANK, REASON);
  expect(result).toEqual({ ok: true, householdRef: "HH-2026-0001", last4: "3210", replacedExisting: true });

  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toMatch(/\/api\/v1\/households\/HH-2026-0001\/bank-details$/);
  expect(init).toMatchObject({ method: "PUT", headers: { Authorization: "Bearer tok-1" } });
  expect(JSON.parse(init.body)).toEqual({ bank: BANK, reason: REASON });
});

it.each([
  [404, { error: "not_found" }, "not-found"],
  [400, { error: "reason_required" }, "reason-required"],
  [400, { error: "invalid_bank_details" }, "invalid-bank"],
  [403, { error: "forbidden" }, "forbidden"],
])("maps HTTP %i %j to %s", async (status, body, reason) => {
  respond(status, body);
  const result = await setHouseholdBankDetails("HH-2026-0001", BANK, REASON);
  expect(result).toEqual({ ok: false, failure: { reason } });
});

it("reports a transport failure as network, and no session without a request", async () => {
  fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
  await expect(setHouseholdBankDetails("HH-2026-0001", BANK, REASON)).resolves.toEqual({
    ok: false,
    failure: { reason: "network" },
  });

  mockToken.mockResolvedValue(null);
  fetchMock.mockClear();
  await expect(setHouseholdBankDetails("HH-2026-0001", BANK, REASON)).resolves.toEqual({
    ok: false,
    failure: { reason: "forbidden" },
  });
  expect(fetchMock).not.toHaveBeenCalled();
});
