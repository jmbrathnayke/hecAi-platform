import { render, screen, fireEvent } from "@testing-library/react";
import { DistrictPicker, type DistrictSelection } from "@/components/DistrictPicker";

const LABELS = {
  districtLabel: "District (optional)",
  districtPlaceholder: "Select district",
  dsDivisionLabel: "DS Division (optional)",
  dsDivisionPlaceholder: "Select division",
};

describe("DistrictPicker", () => {
  it("renders only the district select initially, division select hidden", () => {
    render(<DistrictPicker value={null} onChange={() => {}} {...LABELS} />);
    expect(screen.getByLabelText("District (optional)")).toBeInTheDocument();
    expect(screen.queryByLabelText("DS Division (optional)")).not.toBeInTheDocument();
  });

  it("reveals the division select once a district is chosen, and calls onChange(null) for the district-only pick", () => {
    const onChange = jest.fn();
    render(<DistrictPicker value={null} onChange={onChange} {...LABELS} />);
    const districtSelect = screen.getByLabelText("District (optional)");
    const firstOption = (districtSelect as HTMLSelectElement).options[1].value;
    fireEvent.change(districtSelect, { target: { value: firstOption } });

    expect(screen.getByLabelText("DS Division (optional)")).toBeInTheDocument();
    // Picking a district alone is not a complete pair yet -> null, never a partial object.
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("calls onChange with a complete {district, dsDivision} pair once both are picked", () => {
    const onChange = jest.fn();
    render(<DistrictPicker value={null} onChange={onChange} {...LABELS} />);
    const districtSelect = screen.getByLabelText("District (optional)") as HTMLSelectElement;
    const district = districtSelect.options[1].value;
    fireEvent.change(districtSelect, { target: { value: district } });

    const divisionSelect = screen.getByLabelText("DS Division (optional)") as HTMLSelectElement;
    const division = divisionSelect.options[1].value;
    fireEvent.change(divisionSelect, { target: { value: division } });

    expect(onChange).toHaveBeenLastCalledWith({ district, dsDivision: division });
  });

  it("clears the division back to null when the division select is reset to blank", () => {
    const onChange = jest.fn();
    const value: DistrictSelection = { district: "අනුරාධපුරය", dsDivision: "ඉපලෝගම" };
    render(<DistrictPicker value={value} onChange={onChange} {...LABELS} />);
    const divisionSelect = screen.getByLabelText("DS Division (optional)");
    fireEvent.change(divisionSelect, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("never marks either select as required — the field is purely additive", () => {
    render(<DistrictPicker value={null} onChange={() => {}} {...LABELS} />);
    expect(screen.getByLabelText("District (optional)")).not.toBeRequired();
  });
});
