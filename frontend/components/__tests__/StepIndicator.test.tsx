import { render, screen } from "@testing-library/react";
import { StepIndicator } from "@/components/StepIndicator";

const STEPS = ["Identity", "Location", "Damage", "Photos"];

describe("StepIndicator", () => {
  it("renders all step labels", () => {
    render(<StepIndicator steps={STEPS} currentStep={0} />);
    for (const label of STEPS) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("marks the current step with aria-current='step'", () => {
    render(<StepIndicator steps={STEPS} currentStep={0} />);
    const current = screen.getByText("Identity").closest("li");
    expect(current).toHaveAttribute("aria-current", "step");
  });

  it("only one step is active at a time", () => {
    render(<StepIndicator steps={STEPS} currentStep={2} />);
    const active = document.querySelectorAll('li[aria-current="step"]');
    expect(active).toHaveLength(1);
    expect(screen.getByText("Damage").closest("li")).toHaveAttribute("aria-current", "step");
  });
});
