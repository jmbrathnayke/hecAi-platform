// Global Jest setup: jest-dom matchers + polyfills jsdom lacks.
import "@testing-library/jest-dom";
import { TextEncoder, TextDecoder } from "node:util";
import { webcrypto } from "node:crypto";

// jsdom does not provide TextEncoder/TextDecoder or a full WebCrypto with subtle.
if (typeof (globalThis as { TextEncoder?: unknown }).TextEncoder === "undefined") {
  (globalThis as unknown as { TextEncoder: unknown }).TextEncoder = TextEncoder;
  (globalThis as unknown as { TextDecoder: unknown }).TextDecoder = TextDecoder;
}
if (!globalThis.crypto || !globalThis.crypto.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

// jsdom has no ResizeObserver -- recharts' ResponsiveContainer (Story 7.1 analytics charts)
// requires one to exist, even though jsdom can't produce real layout dimensions for it to
// report. A no-op stub is enough: chart page tests assert on headings/empty-states/aria
// labels, not on recharts' internal SVG geometry.
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}
