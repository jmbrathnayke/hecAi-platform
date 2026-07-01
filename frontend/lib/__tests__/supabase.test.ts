/**
 * @jest-environment node
 */
// lib/supabase.ts is a thin wrapper over @supabase/ssr — verify it forwards the right
// URL/key/cookie-adapter rather than re-testing the vendor SDK itself.
const mockBrowserClient = { auth: {} };
const mockServerClient = { auth: {} };
const createBrowserClient = jest.fn(() => mockBrowserClient);
const createServerClient = jest.fn(() => mockServerClient);

jest.mock("@supabase/ssr", () => ({
  createBrowserClient: (...args: unknown[]) => (createBrowserClient as (...a: unknown[]) => unknown)(...args),
  createServerClient: (...args: unknown[]) => (createServerClient as (...a: unknown[]) => unknown)(...args),
}));

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  };
  createBrowserClient.mockClear();
  createServerClient.mockClear();
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

test("createClient forwards the configured URL and anon key", async () => {
  const { createClient } = await import("../supabase");
  const client = createClient();
  expect(createBrowserClient).toHaveBeenCalledWith("https://example.supabase.co", "anon-key");
  expect(client).toBe(mockBrowserClient);
});

test("createServerSupabaseClient forwards the cookie adapter", async () => {
  const { createServerSupabaseClient } = await import("../supabase");
  const cookies = { getAll: () => [], setAll: () => {} };
  const client = createServerSupabaseClient(cookies);
  expect(createServerClient).toHaveBeenCalledWith(
    "https://example.supabase.co",
    "anon-key",
    { cookies },
  );
  expect(client).toBe(mockServerClient);
});

test("createClient throws a clear config error when the URL env var is missing, instead of calling the SDK with undefined", async () => {
  process.env = { ...ORIGINAL_ENV, NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key" };
  const { createClient } = await import("../supabase");
  expect(() => createClient()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  expect(createBrowserClient).not.toHaveBeenCalled();
});

test("createServerSupabaseClient throws a clear config error when the anon key env var is missing", async () => {
  process.env = { ...ORIGINAL_ENV, NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co" };
  const { createServerSupabaseClient } = await import("../supabase");
  expect(() => createServerSupabaseClient({ getAll: () => [], setAll: () => {} })).toThrow(
    /NEXT_PUBLIC_SUPABASE_ANON_KEY/,
  );
  expect(createServerClient).not.toHaveBeenCalled();
});
