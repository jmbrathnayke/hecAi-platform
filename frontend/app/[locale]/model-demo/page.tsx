"use client";

/**
 * On-device model demonstration harness (RER-2 / FR-2.1 / FR-2.2).
 *
 * Pick a damage photo, see what the deployed MobileNetV2 predicts — class, confidence, severity
 * band and end-to-end latency. Sibling of /rer7-harness: a research/demo surface, not part of the
 * officer workflow.
 *
 * WHY IT EXISTS SEPARATELY FROM /officer/classify. That page is the real workflow and needs an
 * authenticated officer with assigned divisions; it also writes the result to IndexedDB and the
 * case draft. This page needs no session and writes nothing, so the model can be demonstrated
 * even when auth or the backend is unavailable. It calls the SAME classifyImage() from
 * lib/mobilenet.ts, so what it shows is the deployed model's real behaviour, not a mock.
 */
import { useCallback, useRef, useState } from "react";
import { classifyImage, MODEL_VERSION, type ClassificationResult } from "@/lib/mobilenet";
import { OOD_CALIBRATION, OOD_GATE_VERSION, OOD_THRESHOLD } from "@/lib/oodGate";

type State = "idle" | "running" | "done" | "failed";

const CLASS_LABEL: Record<string, string> = {
  crop_damage: "Crop damage",
  property_damage: "Property damage",
  no_damage: "No damage",
};

export default function ModelDemo() {
  const [state, setState] = useState<State>("idle");
  const [result, setResult] = useState<ClassificationResult | null>(null);
  const [error, setError] = useState<string>("");
  const [preview, setPreview] = useState<string>("");
  const [fileName, setFileName] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);

  const run = useCallback(async (file: File) => {
    setState("running");
    setError("");
    setResult(null);
    setFileName(`${file.name} (${(file.size / 1024).toFixed(0)} KB, ${file.type || "unknown type"})`);
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(file);
    });
    try {
      const r = await classifyImage(file);
      setResult(r);
      setState("done");
    } catch (err) {
      // Surfaced in the UI, not just the console: the whole point of this page is that a
      // failure tells you WHY. The officer page can only afford one line of reassuring copy.
      const e = err as Error & { cause?: unknown };
      const cause = e?.cause as Error | undefined;
      setError(`${e?.name ?? "Error"}: ${e?.message ?? String(err)}${cause ? `\ncause -> ${cause.name}: ${cause.message}` : ""}`);
      setState("failed");
    }
  }, []);

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>On-device damage classification</h1>
      <p style={{ color: "#555", fontSize: 14, marginTop: 0 }}>
        MobileNetV2 running entirely in this browser via TensorFlow.js — no image leaves the
        device. Model version <code>{MODEL_VERSION}</code>.
      </p>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        data-testid="model-demo-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void run(f);
        }}
        style={{ display: "block", margin: "20px 0", fontSize: 15 }}
      />

      {state === "running" && <p data-testid="demo-state">Classifying…</p>}

      {preview && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview}
          alt="selected damage photo"
          style={{ maxWidth: "100%", maxHeight: 320, borderRadius: 8, border: "1px solid #ddd" }}
        />
      )}
      {fileName && <p style={{ fontSize: 12, color: "#777" }}>{fileName}</p>}

      {state === "done" && result && (
        <div
          data-testid="demo-result"
          style={{ marginTop: 16, padding: 16, border: "1px solid #cfe3cf", background: "#f3faf3", borderRadius: 8 }}
        >
          <div style={{ fontSize: 26, fontWeight: 700 }}>
            {CLASS_LABEL[result.classId] ?? result.classId}
          </div>
          <table style={{ marginTop: 12, fontSize: 15, borderSpacing: "0 4px" }}>
            <tbody>
              <tr><td style={{ paddingRight: 18, color: "#555" }}>Confidence</td>
                  <td data-testid="demo-confidence"><b>{(result.confidence * 100).toFixed(1)}%</b></td></tr>
              <tr><td style={{ paddingRight: 18, color: "#555" }}>Severity</td>
                  <td data-testid="demo-severity"><b>{result.severity}</b></td></tr>
              <tr><td style={{ paddingRight: 18, color: "#555" }}>Raw class id</td>
                  <td><code>{result.classId}</code></td></tr>
              <tr><td style={{ paddingRight: 18, color: "#555" }}>Processing time</td>
                  <td>{result.processingTimeMs.toFixed(0)} ms <span style={{ color: "#777" }}>(decode + resize + inference)</span></td></tr>
              {/* The gate's own numbers. This page exists so the model can be INSPECTED, so it
                  shows the distance and the threshold rather than only the verdict — that is what
                  makes "why was this rejected?" answerable in a viva. */}
              <tr><td style={{ paddingRight: 18, color: "#555" }}>Domain distance</td>
                  <td data-testid="demo-distance">
                    {result.domainDistance == null
                      ? <span style={{ color: "#a00" }}>gate did not run</span>
                      : <><b>{result.domainDistance.toFixed(3)}</b>{" "}
                          <span style={{ color: "#777" }}>
                            / threshold {OOD_THRESHOLD.toFixed(3)} ({OOD_GATE_VERSION})
                          </span></>}
                  </td></tr>
              {result.outOfDomain && (
                <tr><td style={{ paddingRight: 18, color: "#555" }}>Closed-set answer</td>
                    <td data-testid="demo-raw">
                      <code>{result.rawClassId}</code>{" "}
                      <span style={{ color: "#777" }}>
                        at {((result.rawConfidence ?? 0) * 100).toFixed(1)}% — discarded by the gate
                      </span>
                    </td></tr>
              )}
            </tbody>
          </table>

          {result.outOfDomain && (
            <p
              data-testid="demo-ood"
              style={{ marginTop: 12, padding: 12, background: "#fff7e6", border: "1px solid #e8c97a", borderRadius: 6, fontSize: 14 }}
            >
              <b>Out of domain.</b> This photo resembles none of the three classes the model was
              trained on, so the class it would otherwise have returned was discarded and the
              result recorded as <code>no_damage</code> — no compensation is estimated from it.
              The threshold is the {OOD_CALIBRATION.percentile}th percentile of the in-domain
              distance distribution, measured leave-one-out over{" "}
              {OOD_CALIBRATION.in_domain_n} training photographs.
            </p>
          )}
        </div>
      )}

      {state === "failed" && (
        <pre
          data-testid="demo-error"
          style={{ marginTop: 16, padding: 16, background: "#fdf0f0", border: "1px solid #e6c0c0", borderRadius: 8, whiteSpace: "pre-wrap", fontSize: 13 }}
        >
          {error}
        </pre>
      )}
    </main>
  );
}
