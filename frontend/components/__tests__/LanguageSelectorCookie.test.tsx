import { fireEvent, render, screen } from "@testing-library/react";
import { LanguageSelectorCookie } from "@/components/LanguageSelectorCookie";

// Active locale is English for these tests.
jest.mock("next-intl", () => ({
  useLocale: () => "en",
}));

const mockRefresh = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: (...a: unknown[]) => mockRefresh(...a) }),
}));

beforeEach(() => {
  mockRefresh.mockReset();
  // Clear cookies + localStorage between tests.
  document.cookie = "NEXT_LOCALE=;path=/;max-age=0";
  localStorage.clear();
});

test("selecting a new locale writes the NEXT_LOCALE cookie, mirrors to localStorage, and refreshes", () => {
  render(<LanguageSelectorCookie />);
  fireEvent.click(screen.getByRole("button", { name: "සිංහල" }));

  expect(document.cookie).toContain("NEXT_LOCALE=si");
  expect(localStorage.getItem("hec-locale")).toBe("si");
  expect(mockRefresh).toHaveBeenCalledTimes(1);
});

test("selecting Tamil persists 'ta'", () => {
  render(<LanguageSelectorCookie />);
  fireEvent.click(screen.getByRole("button", { name: "தமிழ்" }));

  expect(document.cookie).toContain("NEXT_LOCALE=ta");
  expect(localStorage.getItem("hec-locale")).toBe("ta");
  expect(mockRefresh).toHaveBeenCalledTimes(1);
});

test("selecting the already-active locale is a no-op (no cookie write, no refresh)", () => {
  render(<LanguageSelectorCookie />);
  fireEvent.click(screen.getByRole("button", { name: "English" }));

  expect(document.cookie).not.toContain("NEXT_LOCALE=en");
  expect(localStorage.getItem("hec-locale")).toBeNull();
  expect(mockRefresh).not.toHaveBeenCalled();
});

test("the active locale button is marked aria-pressed", () => {
  render(<LanguageSelectorCookie />);
  expect(screen.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "සිංහල" })).toHaveAttribute("aria-pressed", "false");
});
