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
