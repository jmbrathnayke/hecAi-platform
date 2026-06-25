import type { Config } from "jest";
import nextJest from "next/jest.js";

// next/jest wires up SWC transform, CSS/asset mocks, and tsconfig paths for Next.js.
const createJestConfig = nextJest({ dir: "./" });

const config: Config = {
  coverageProvider: "v8",
  testEnvironment: "jsdom",
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
};

export default createJestConfig(config);
