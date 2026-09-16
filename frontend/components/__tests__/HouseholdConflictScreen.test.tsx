import { render, screen } from "@testing-library/react";
import { HouseholdConflictScreen } from "@/components/HouseholdConflictScreen";
import en from "@/messages/en.json";
import si from "@/messages/si.json";
import ta from "@/messages/ta.json";

// Locale-aware Link renders as a plain anchor here; routing is next-intl's concern, not this
// component's.
jest.mock("@/navigation", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

/** Identity translator, so a missing key shows up as the key itself rather than silently blank. */
const tKey = (k: string) => k;

/** Real English copy, so the wording assertions below test what a citizen actually reads. */
const conflict = (en as { register: { conflict: Record<string, string> } }).register.conflict;
const tReal = (k: string) => conflict[k.replace("conflict.", "")] ?? k;

describe("EXPERIENCE.md requirements for the already-registered screen", () => {
  it("(1) states the situation and never says error, duplicate, or a code", () => {
    render(
      <HouseholdConflictScreen variant="family-registered" householdRef="HH-2026-0001" t={tReal} />,
    );
    expect(
      screen.getByRole("heading", { name: conflict.titleFamily }),
    ).toBeInTheDocument();

    const text = screen.getByTestId("household-conflict").textContent ?? "";
    expect(text.toLowerCase()).not.toContain("error");
    expect(text.toLowerCase()).not.toContain("duplicate");
    expect(text).not.toContain("409");
    expect(text).not.toContain("nic_already_registered");
  });

  it("(2) names the existing household reference", () => {
    render(
      <HouseholdConflictScreen variant="family-registered" householdRef="HH-2026-0042" t={tKey} />,
    );
    expect(screen.getByTestId("conflict-household-ref")).toHaveTextContent("HH-2026-0042");
  });

  it("(3) explains why in one sentence", () => {
    render(
      <HouseholdConflictScreen variant="family-registered" householdRef="HH-2026-0001" t={tReal} />,
    );
    expect(screen.getByText(conflict.why)).toBeInTheDocument();
  });

  it("(4) says to talk to the Divisional Secretariat office", () => {
    render(
      <HouseholdConflictScreen variant="family-registered" householdRef="HH-2026-0001" t={tReal} />,
    );
    expect(screen.getByText(conflict.whatToDo)).toBeInTheDocument();
    expect(conflict.whatToDo).toContain("Divisional Secretariat");
  });

  it("(5) offers real next actions, and no bare Back", () => {
    render(
      <HouseholdConflictScreen variant="family-registered" householdRef="HH-2026-0001" t={tKey} />,
    );
    expect(screen.getByText("conflict.checkStatus").closest("a")).toHaveAttribute("href", "/status");
    expect(screen.getByText("conflict.goHome").closest("a")).toHaveAttribute("href", "/");
    expect(screen.queryByText(/^back$/i)).not.toBeInTheDocument();
  });

  it("is announced as information, not as an alert", () => {
    render(
      <HouseholdConflictScreen variant="family-registered" householdRef="HH-2026-0001" t={tKey} />,
    );
    // role="alert" would make a screen reader interrupt with what reads as a failure.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});

describe("the two variants differ where it matters", () => {
  it("own-account offers reporting an incident, and drops the DS instruction", () => {
    render(<HouseholdConflictScreen variant="own-account" householdRef="HH-2026-0007" t={tKey} />);
    expect(screen.getByText("conflict.titleYou")).toBeInTheDocument();
    expect(screen.getByText("conflict.reportIncident").closest("a")).toHaveAttribute(
      "href",
      "/report",
    );
    // Nothing to sort out at the DS office — this citizen is simply already done.
    expect(screen.queryByText("conflict.whatToDo")).not.toBeInTheDocument();
  });

  it("family-registered keeps the DS instruction and does not offer reporting", () => {
    render(
      <HouseholdConflictScreen variant="family-registered" householdRef="HH-2026-0001" t={tKey} />,
    );
    expect(screen.getByText("conflict.titleFamily")).toBeInTheDocument();
    expect(screen.getByText("conflict.whatToDo")).toBeInTheDocument();
    // They are not registered under this account, so sending them to the incident form would
    // dead-end at the FR-10.3 submit gate.
    expect(screen.queryByText("conflict.reportIncident")).not.toBeInTheDocument();
  });
});

describe("trilingual parity", () => {
  const localised = {
    si: (si as { register: { conflict: Record<string, string> } }).register.conflict,
    ta: (ta as { register: { conflict: Record<string, string> } }).register.conflict,
  };

  it.each(["si", "ta"] as const)(
    "%s has every key the screen renders, none left as English",
    (locale) => {
      const messages = localised[locale];
      for (const key of Object.keys(conflict)) {
        expect(messages[key]).toBeDefined();
        // An untranslated string that is byte-identical to English means the key was copied
        // and never localised — the exact gap triage item A7 exists to catch.
        expect(messages[key]).not.toBe(conflict[key]);
      }
    },
  );
});
