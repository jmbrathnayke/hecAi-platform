import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { DistrictPicker, type DistrictSelection } from "@/components/DistrictPicker";

const LABELS = {
  districtLabel: "District (optional)",
  districtPlaceholder: "Select district",
  dsDivisionLabel: "DS Division (optional)",
  dsDivisionPlaceholder: "Select division",
};

/** Mimics a real parent: owns the selection in its own state, passes it straight
 * through to the picker (same reference DistrictPicker itself emitted via onChange). */
function ControlledWrapper({
  initial,
  onChangeSpy,
}: {
  initial: DistrictSelection | null;
  onChangeSpy: (v: DistrictSelection | null) => void;
}) {
  const [value, setValue] = useState<DistrictSelection | null>(initial);
  return (
    <DistrictPicker
      value={value}
      onChange={(v) => {
        setValue(v);
        onChangeSpy(v);
      }}
      {...LABELS}
    />
  );
}

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

  // Code review fix: value prop resync (previously the component only ever read
  // `value` once, at construction, via useState(value?.district ?? "")).
  describe("resyncing when `value` changes externally after mount", () => {
    it("updates the visible district when a real parent's value changes post-mount (e.g. an async draft load)", () => {
      const onChange = jest.fn();
      const { rerender } = render(<DistrictPicker value={null} onChange={onChange} {...LABELS} />);
      const districtSelect = screen.getByLabelText("District (optional)") as HTMLSelectElement;
      expect(districtSelect.value).toBe("");

      const loadedDistrict = districtSelect.options[1].value;
      rerender(
        <DistrictPicker
          value={{ district: loadedDistrict, dsDivision: "" }}
          onChange={onChange}
          {...LABELS}
        />,
      );
      expect((screen.getByLabelText("District (optional)") as HTMLSelectElement).value).toBe(
        loadedDistrict,
      );
    });

    it("does NOT stomp the district the user just picked (regression guard for the naive fix)", () => {
      // Uses a real stateful wrapper (not a bare mock onChange) so that picking a
      // district's own onChange(null) genuinely round-trips back through `value` the
      // same way the real app does — this is exactly the scenario a naive
      // `useEffect(() => setDistrict(value?.district ?? ""), [value?.district])`
      // would break: onChange(null) -> value becomes null -> effect fires -> district
      // reset to "" before the user ever sees the division dropdown.
      const onChangeSpy = jest.fn();
      render(<ControlledWrapper initial={null} onChangeSpy={onChangeSpy} />);
      const districtSelect = screen.getByLabelText("District (optional)") as HTMLSelectElement;
      const district = districtSelect.options[1].value;
      fireEvent.change(districtSelect, { target: { value: district } });

      expect((screen.getByLabelText("District (optional)") as HTMLSelectElement).value).toBe(
        district,
      );
      expect(screen.getByLabelText("DS Division (optional)")).toBeInTheDocument();
    });

    it("lets the user switch to a different district after already completing a pair", () => {
      // The trickier regression case: value is a NON-null complete pair, then the user
      // picks a different district. onChange(null) round-trips through the same
      // stateful parent, and value?.district genuinely changes (old district -> null)
      // -- the fix must still not stomp the newly-picked district.
      const onChangeSpy = jest.fn();
      const first: DistrictSelection = { district: "අනුරාධපුරය", dsDivision: "ඉපලෝගම" };
      render(<ControlledWrapper initial={first} onChangeSpy={onChangeSpy} />);

      const districtSelect = screen.getByLabelText("District (optional)") as HTMLSelectElement;
      const otherOption = Array.from(districtSelect.options).find(
        (o) => o.value && o.value !== first.district,
      )!;
      fireEvent.change(districtSelect, { target: { value: otherOption.value } });

      expect((screen.getByLabelText("District (optional)") as HTMLSelectElement).value).toBe(
        otherOption.value,
      );
    });
  });

  it("shows a blank division select rather than a stale one when value.dsDivision isn't in the current district's division list", () => {
    // Reference-data version-drift guard: value carries a division that doesn't
    // belong to (or no longer exists under) the given district.
    const value: DistrictSelection = { district: "අනුරාධපුරය", dsDivision: "NoSuchDivision" };
    render(<DistrictPicker value={value} onChange={() => {}} {...LABELS} />);
    const divisionSelect = screen.getByLabelText("DS Division (optional)") as HTMLSelectElement;
    expect(divisionSelect.value).toBe("");
  });
});
