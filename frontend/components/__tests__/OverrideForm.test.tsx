import { render, screen, fireEvent } from "@testing-library/react";
import { OverrideForm } from "@/components/OverrideForm";

function setup(currentCategory: "crop_damage" | "no_damage" | "property_damage" = "property_damage") {
  const onConfirm = jest.fn();
  const onCancel = jest.fn();
  render(
    <OverrideForm currentCategory={currentCategory} onConfirm={onConfirm} onCancel={onCancel} />,
  );
  return { onConfirm, onCancel };
}

function confirmButton() {
  return screen.getByRole("button", { name: "Confirm Override" });
}

describe("OverrideForm", () => {
  it("renders exactly the 3 model classes (no 'combined') as options (AC1)", () => {
    setup();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(screen.getByLabelText("Crop Damage")).toBeInTheDocument();
    expect(screen.getByLabelText("No Damage")).toBeInTheDocument();
    expect(screen.getByLabelText("Property Damage")).toBeInTheDocument();
    expect(screen.queryByLabelText(/combined/i)).not.toBeInTheDocument();
  });

  it("preselects the category to the AI's prediction (AC1)", () => {
    setup("crop_damage");
    expect(screen.getByLabelText("Crop Damage")).toBeChecked();
    expect(screen.getByLabelText("Property Damage")).not.toBeChecked();
  });

  it("disables Confirm and shows the hint while the reason is under 10 non-whitespace chars (AC2)", () => {
    setup();
    // Empty → disabled + hint.
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByText("Please provide a more detailed reason")).toBeInTheDocument();

    // 9 chars → still disabled.
    fireEvent.change(screen.getByLabelText("Reason for override"), {
      target: { value: "too short" },
    });
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByText("Please provide a more detailed reason")).toBeInTheDocument();
  });

  it("treats surrounding whitespace as not counting toward the 10-char minimum (AC2)", () => {
    setup();
    fireEvent.change(screen.getByLabelText("Reason for override"), {
      target: { value: "   short   " }, // 5 non-whitespace chars
    });
    expect(confirmButton()).toBeDisabled();
  });

  it("enables Confirm once the reason has at least 10 non-whitespace chars (AC2)", () => {
    setup();
    fireEvent.change(screen.getByLabelText("Reason for override"), {
      target: { value: "roof visibly collapsed" },
    });
    expect(confirmButton()).toBeEnabled();
    expect(screen.queryByText("Please provide a more detailed reason")).not.toBeInTheDocument();
  });

  it("fires onConfirm with the selected category and the trimmed reason (AC3)", () => {
    const { onConfirm } = setup("property_damage");
    fireEvent.click(screen.getByLabelText("Crop Damage"));
    fireEvent.change(screen.getByLabelText("Reason for override"), {
      target: { value: "  paddy field flooded, not a building  " },
    });
    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith("crop_damage", "paddy field flooded, not a building");
  });

  it("fires onCancel when Cancel is tapped", () => {
    const { onCancel } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
