import { render, screen } from "@testing-library/react";
import { OfficerTopBar } from "@/components/OfficerTopBar";

describe("OfficerTopBar", () => {
  it("renders the label as the screen's single h1", () => {
    render(<OfficerTopBar label="Step 4 of 5 — Photos" />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Step 4 of 5 — Photos");
  });

  it("marks dots complete / active / upcoming around the current step", () => {
    const { container } = render(
      <OfficerTopBar label="Step 3 of 5" totalSteps={5} currentStep={2} />,
    );
    const states = Array.from(container.querySelectorAll("[data-state]")).map((el) =>
      el.getAttribute("data-state"),
    );
    expect(states).toEqual(["done", "done", "active", "upcoming", "upcoming"]);
  });

  it("hides the dots from assistive tech — the label already carries the progress", () => {
    const { container } = render(<OfficerTopBar label="Step 1 of 5" totalSteps={5} currentStep={0} />);
    expect(container.querySelector("[aria-hidden='true']")).toContainElement(
      container.querySelector("[data-state='active']"),
    );
  });

  it("renders no dot rail on a non-stepped screen", () => {
    const { container } = render(<OfficerTopBar label="Sync Queue" />);
    expect(container.querySelectorAll("[data-state]")).toHaveLength(0);
  });

  it("shows the trailing action when there are no step dots", () => {
    render(<OfficerTopBar label="Damage Classification" action={<button>Start new case</button>} />);
    expect(screen.getByRole("button", { name: "Start new case" })).toBeInTheDocument();
  });

  it("gives the dots precedence over an action, so the bar never renders both", () => {
    render(
      <OfficerTopBar
        label="Step 2 of 5"
        totalSteps={5}
        currentStep={1}
        action={<button>Start new case</button>}
      />,
    );
    expect(screen.queryByRole("button", { name: "Start new case" })).not.toBeInTheDocument();
  });
});
