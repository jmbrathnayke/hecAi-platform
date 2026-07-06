import { deriveCaseCategory } from "@/lib/classification";
import type { ClassId } from "@/lib/mobilenet";

describe("deriveCaseCategory", () => {
  it("returns 'combined' when both crop and property damage are present", () => {
    expect(deriveCaseCategory(["crop_damage", "property_damage"])).toBe("combined");
    expect(deriveCaseCategory(["no_damage", "crop_damage", "property_damage"])).toBe("combined");
    expect(deriveCaseCategory(["property_damage", "crop_damage"])).toBe("combined");
  });

  it("returns the single damage class when only one kind is present", () => {
    expect(deriveCaseCategory(["crop_damage"])).toBe("crop_damage");
    expect(deriveCaseCategory(["crop_damage", "no_damage", "crop_damage"])).toBe("crop_damage");
    expect(deriveCaseCategory(["property_damage", "no_damage"])).toBe("property_damage");
  });

  it("returns 'no_damage' when no damage is present", () => {
    expect(deriveCaseCategory(["no_damage"])).toBe("no_damage");
    expect(deriveCaseCategory(["no_damage", "no_damage"])).toBe("no_damage");
  });

  it("returns 'no_damage' for an empty photo set", () => {
    expect(deriveCaseCategory([] as ClassId[])).toBe("no_damage");
  });
});
