import { updateMyHousehold } from "@/lib/households";
import { getAccessToken } from "@/lib/auth";

jest.mock("@/lib/auth", () => ({ getAccessToken: jest.fn() }));

const mockToken = getAccessToken as jest.Mock;
const fetchMock = jest.fn();
const originalEnv = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
};

afterAll(() => {
  // A Jest worker runs other test files in the same process; leave the environment as found.
  if (originalEnv.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = originalEnv.url;
  if (originalEnv.key === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalEnv.key;
});

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

it("PATCHes the caller's own household with the bearer token", async () => {
  respond(200, { household_ref: "HH-2026-0005", members: [] });
  const result = await updateMyHousehold({ address: "No. 1, Road" });
  expect(result).toEqual({ ok: true, household: { household_ref: "HH-2026-0005", members: [] } });
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toMatch(/\/api\/v1\/households\/me$/);
  expect(init).toMatchObject({ method: "PATCH", headers: { Authorization: "Bearer tok-1" } });
  expect(JSON.parse(init.body)).toEqual({ address: "No. 1, Road" });
});

it.each([
  [400, { error: "missing_fields", fields: ["address"] }, "invalid-address"],
  [400, { error: "invalid_email" }, "invalid-email"],
  [400, { error: "invalid_mobile" }, "invalid-mobile"],
  [400, { error: "invalid_bank_details" }, "invalid-bank"],
  [409, { error: "bank_details_locked" }, "bank-locked"],
  [404, { error: "not_registered" }, "not-registered"],
  [401, { error: "token_expired" }, "no-session"],
])("maps HTTP %i %j to %s", async (status, body, reason) => {
  respond(status, body);
  const result = await updateMyHousehold({ address: "x" });
  expect(result).toEqual({ ok: false, failure: { reason } });
});

it("reports a transport failure as network, and no session without a request", async () => {
  fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
  await expect(updateMyHousehold({ address: "x" })).resolves.toEqual({ ok: false, failure: { reason: "network" } });

  mockToken.mockResolvedValue(null);
  fetchMock.mockClear();
  await expect(updateMyHousehold({ address: "x" })).resolves.toEqual({ ok: false, failure: { reason: "no-session" } });
  expect(fetchMock).not.toHaveBeenCalled();
});
