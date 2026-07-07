import { render, screen, fireEvent } from "@testing-library/react";
import { DamageCard } from "@/components/DamageCard";

describe("DamageCard", () => {
  it("renders as a radio with the label", () => {
    render(<DamageCard category="crop" label="Crop Damage" selected={false} onSelect={() => {}} />);
    const radio = screen.getByRole("radio", { name: /crop damage/i });
    expect(radio).toBeInTheDocument();
    expect(radio).toHaveAttribute("aria-checked", "false");
  });

  it("reflects the selected state via aria-checked", () => {
    render(<DamageCard category="property" label="Property Damage" selected onSelect={() => {}} />);
    expect(screen.getByRole("radio")).toHaveAttribute("aria-checked", "true");
  });

  it("calls onSelect when tapped", () => {
    const onSelect = jest.fn();
    render(<DamageCard category="none" label="No Visible Damage" selected={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("radio"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
