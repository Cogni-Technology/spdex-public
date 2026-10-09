import { defineConfig } from "vitest/config";
import { loadEnvFiles } from "./scripts/env.mjs";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: [
            "packages/*/src/**/*.test.ts",
            "modules/*/src/**/*.test.ts",
            "modules/*/test/unit/**/*.test.ts",
            "apps/*/src/**/*.test.ts",
            // The verify gate's own argument parsing: a gate that misreads its
            // arguments reports green on runs that checked nothing.
            "scripts/*.test.ts",
          ],
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          // The fork anchor lives in .env.defaults; integration tests assert
          // against it, so it has to reach the test process.
          env: loadEnvFiles(),
          include: [
            "packages/*/test/integration/**/*.test.ts",
            "modules/*/test/integration/**/*.test.ts",
            "apps/*/test/integration/**/*.test.ts",
          ],
          // Fork boot plus real multicalls; the 5s default is not close to enough.
          testTimeout: 120_000,
          hookTimeout: 120_000,
          // Anvil is a single shared fork — parallel files would fight over state.
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "conformance",
          environment: "node",
          include: ["packages/module-sdk/test/conformance/**/*.test.ts"],
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: "parity",
          environment: "node",
          include: ["packages/host/test/parity/**/*.test.ts"],
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: "redteam",
          environment: "node",
          include: ["packages/guard/test/redteam/**/*.test.ts"],
          testTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
