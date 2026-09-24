/**
 * Every string exists in all three languages (FR-9.1). A key present in English but missing in
 * Sinhala or Tamil renders as a raw message key to that reader.
 */
import en from "@/messages/en.json";
import si from "@/messages/si.json";
import ta from "@/messages/ta.json";

function keys(tree: unknown, prefix = ""): string[] {
  if (!tree || typeof tree !== "object") return [prefix];
  return Object.entries(tree as Record<string, unknown>).flatMap(([k, v]) =>
    v && typeof v === "object" ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

function strings(tree: unknown): string[] {
  if (typeof tree === "string") return [tree];
  if (!tree || typeof tree !== "object") return [];
  return Object.values(tree as Record<string, unknown>).flatMap(strings);
}

test("si and ta carry exactly the English keys", () => {
  const base = new Set(keys(en));
  for (const [name, catalogue] of Object.entries({ si, ta })) {
    const other = new Set(keys(catalogue));
    expect({ name, missing: [...base].filter((k) => !other.has(k)) }).toEqual({ name, missing: [] });
    expect({ name, extra: [...other].filter((k) => !base.has(k)) }).toEqual({ name, extra: [] });
  }
});

test("no catalogue contains an unrendered template literal or an empty string", () => {
  for (const catalogue of [en, si, ta]) {
    for (const s of strings(catalogue)) {
      expect(s).not.toMatch(/\$\{/);
      expect(s.trim()).not.toBe("");
    }
  }
});

test("the final-workflow namespaces exist in every language", () => {
  for (const catalogue of [en, si, ta] as unknown as Record<string, Record<string, Record<string, unknown>>>[]) {
    expect(catalogue.registrationGate).toBeDefined();
    expect(catalogue.officer.caseReview).toBeDefined();
    expect(catalogue.ds.finalDecision).toBeDefined();
    expect(catalogue.admin.workflow).toBeDefined();
    expect(catalogue.status.stageLabels).toBeDefined();
  }
});
