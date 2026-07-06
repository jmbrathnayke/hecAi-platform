import { render, screen, fireEvent } from "@testing-library/react";
import { AIResultCard } from "@/components/AIResultCard";

const baseProps = {
  classId: "property_damage" as const,
  severity: "Severe" as const,
  confidence: 0.89,
  processingTimeMs: 412.7,
  onAccept: () => {},
  onOverride: () => {},
};

describe("AIResultCard", () => {
  it("renders the localized class label, severity, confidence, and processing time", () => {
    render(<AIResultCard {...baseProps} />);
    expect(screen.getByText("Property Damage")).toBeInTheDocument();
    expect(screen.getByText("Severe")).toBeInTheDocument();
    expect(screen.getByText("89%")).toBeInTheDocument();
    expect(screen.getByText(/413 ms/)).toBeInTheDocument(); // rounded from 412.7
  });

  it("exposes confidence as an accessible progressbar (always-visible signal, NFR-6.2)", () => {
    render(<AIResultCard {...baseProps} confidence={0.42} />);
    const bar = screen.getByRole("progressbar", { name: /confidence/i });
    expect(bar).toHaveAttribute("aria-valuenow", "42");
  });

  it("maps each model class id to its English label", () => {
    const { rerender } = render(<AIResultCard {...baseProps} classId="crop_damage" />);
    expect(screen.getByText("Crop Damage")).toBeInTheDocument();
    rerender(<AIResultCard {...baseProps} classId="no_damage" />);
    expect(screen.getByText("No Damage")).toBeInTheDocument();
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

  it("does not auto-advance — fires callbacks only on explicit Accept/Override taps (NFR-6.1)", () => {
    const onAccept = jest.fn();
    const onOverride = jest.fn();
    render(<AIResultCard {...baseProps} onAccept={onAccept} onOverride={onOverride} />);

    // Nothing fires on render.
    expect(onAccept).not.toHaveBeenCalled();
    expect(onOverride).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onOverride).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Override" }));
    expect(onOverride).toHaveBeenCalledTimes(1);
  });
});
