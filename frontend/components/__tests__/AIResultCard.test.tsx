import { render, screen, fireEvent } from "@testing-library/react";
import { AIResultCard } from "@/components/AIResultCard";

// next-intl passthrough (Story 6.2): the translator returns the key (relative to the namespace),
// appending any interpolation values so tests that check a dynamic value still can.
jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, vars?: Record<string, unknown>) =>
      vars && Object.keys(vars).length ? `${key} ${Object.values(vars).join(" ")}` : key;
    t.rich = (key: string) => key;
    return t;
  },
  useLocale: () => "en",
}));

const baseProps = {
  classId: "property_damage" as const,
  severity: "Severe" as const,
  confidence: 0.89,
  processingTimeMs: 412.7,
  modelVersion: "mobilenetv2-v1",
  onAccept: () => {},
  onOverride: () => {},
};

describe("AIResultCard", () => {
  it("renders the localized class label, severity, confidence, and processing time", () => {
    render(<AIResultCard {...baseProps} />);
    expect(screen.getByText("aiResult.property_damage")).toBeInTheDocument();
    expect(screen.getByText("severity.Severe")).toBeInTheDocument();
    expect(screen.getByText("89%")).toBeInTheDocument();
    expect(screen.getByText(/413/)).toBeInTheDocument(); // rounded from 412.7, interpolated into the key
  });

  it("says beside the number that confidence is not the chance the result is right", () => {
    // The classifier is closed-set: a softmax over three classes, so a photo of a person's face
    // was still read as property damage at 94%. Without this line a high percentage invites
    // exactly that misreading, and the officer's Override loses its point.
    render(<AIResultCard {...baseProps} confidence={0.94} />);
    expect(screen.getByTestId("confidence-caveat")).toHaveTextContent("aiResult.confidenceCaveat");
  });

  it("shows the caveat however high the confidence is — a high number is when it matters most", () => {
    render(<AIResultCard {...baseProps} confidence={0.999} />);
    expect(screen.getByTestId("confidence-caveat")).toBeInTheDocument();
  });

  it("exposes confidence as an accessible progressbar (always-visible signal, NFR-6.2)", () => {
    render(<AIResultCard {...baseProps} confidence={0.42} />);
    const bar = screen.getByRole("progressbar", { name: /confidence/i });
    expect(bar).toHaveAttribute("aria-valuenow", "42");
  });

  it("maps each model class id to its English label", () => {
    const { rerender } = render(<AIResultCard {...baseProps} classId="crop_damage" />);
    expect(screen.getByText("aiResult.crop_damage")).toBeInTheDocument();
    rerender(<AIResultCard {...baseProps} classId="no_damage" />);
    expect(screen.getByText("aiResult.no_damage")).toBeInTheDocument();
  });

  it("clamps an out-of-range or non-finite confidence for the bar + aria (defensive)", () => {
    const { rerender } = render(<AIResultCard {...baseProps} confidence={1.4} />);
    expect(screen.getByRole("progressbar", { name: /confidence/i })).toHaveAttribute(
      "aria-valuenow",
      "100", // clamped down from 140
    );
    rerender(<AIResultCard {...baseProps} confidence={NaN} />);
    expect(screen.getByRole("progressbar", { name: /confidence/i })).toHaveAttribute(
      "aria-valuenow",
      "0", // NaN → 0
    );
  });

  // The photo that started this: a person's face returned as property damage at 94%. The gate
  // (lib/oodGate.ts) now turns that into no_damage, which is the right compensation outcome — but
  // an officer reading a bare "No Damage" would take it as a finding about the land. The card has
  // to say that nothing was recognised.
  describe("out of domain", () => {
    const ood = { ...baseProps, classId: "no_damage" as const, severity: "None" as const, confidence: 0, outOfDomain: true };

    it("explains that the photo matched no trained class, instead of showing a percentage", () => {
      render(<AIResultCard {...ood} />);
      expect(screen.getByTestId("ood-notice")).toHaveTextContent("aiResult.outOfDomainNotice");
      expect(screen.getByTestId("ood-badge")).toHaveTextContent("aiResult.outOfDomainBadge");
      // The softmax compares the three trained classes; this photo is outside all of them, so
      // the number would describe a choice that was thrown away.
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
      expect(screen.queryByTestId("confidence-caveat")).not.toBeInTheDocument();
    });

    it("still names the class it recorded, so the officer sees what was written down", () => {
      render(<AIResultCard {...ood} />);
      expect(screen.getByText("aiResult.no_damage")).toBeInTheDocument();
    });

    it("keeps Override reachable — the officer, not the gate, has the last word", () => {
      const onOverride = jest.fn();
      render(<AIResultCard {...ood} onOverride={onOverride} />);
      fireEvent.click(screen.getByRole("button", { name: "aiResult.override" }));
      expect(onOverride).toHaveBeenCalledTimes(1);
    });

    it("shows the ordinary confidence bar when the gate did not fire", () => {
      render(<AIResultCard {...baseProps} outOfDomain={false} />);
      expect(screen.getByRole("progressbar", { name: /confidence/i })).toBeInTheDocument();
      expect(screen.queryByTestId("ood-notice")).not.toBeInTheDocument();
      expect(screen.queryByTestId("ood-badge")).not.toBeInTheDocument();
    });
  });

  it("does not auto-advance — fires callbacks only on explicit Accept/Override taps (NFR-6.1)", () => {
    const onAccept = jest.fn();
    const onOverride = jest.fn();
    render(<AIResultCard {...baseProps} onAccept={onAccept} onOverride={onOverride} />);

    // Nothing fires on render.
    expect(onAccept).not.toHaveBeenCalled();
    expect(onOverride).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "aiResult.accept" }));
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onOverride).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "aiResult.override" }));
    expect(onOverride).toHaveBeenCalledTimes(1);
  });
});
