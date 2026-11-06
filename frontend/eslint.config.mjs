import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Key-handling guard rails:
 *  - app/** and components/** (anything Next serves) may not import the worker, and may not touch
 *    VERIFIER_KEY or the verifier signer. Only worker/ signs Releases.
 */
const VERIFIER_MSG = "The verifier key is worker-only (worker/signer.ts). Never read VERIFIER_KEY or sign Releases from app/ or components/.";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/worker", "@/worker/*", "**/worker/*", "**/worker"], message: "app/ and components/ must not import the worker (it holds VERIFIER_KEY)." },
          ],
          paths: [
            { name: "@/lib/chain", importNames: ["signRelease"], message: VERIFIER_MSG },
            { name: "@/lib/chain/releaseSig", importNames: ["signRelease", "verifierAccount", "DEV_VERIFIER_KEY", "rawEcdsaKey"], message: VERIFIER_MSG },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "Literal[value='VERIFIER_KEY']", message: VERIFIER_MSG },
        { selector: "Identifier[name='VERIFIER_KEY']", message: VERIFIER_MSG },
      ],
    },
  },
  // Lane B boundaries (tech plan): lib/siege reaches guardians only through lib/transport, and only
  // lib/proxy may call the raw 0G client (every guardian request goes through the vault-scoped key).
  {
    files: ["lib/siege/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/lib/guardian", "@/lib/guardian/*", "**/guardian", "**/guardian/*"], message: "lib/siege must call guardians through lib/transport (GuardianTransport)." },
            { group: ["@/lib/proxy/zg", "@/lib/proxy/mock", "**/proxy/zg", "**/proxy/mock"], message: "Only lib/proxy may call the 0G client." },
          ],
        },
      ],
    },
  },
  {
    files: ["lib/guardian/**/*.ts", "lib/transport/**/*.ts", "worker/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["@/lib/proxy/zg", "@/lib/proxy/mock", "**/proxy/zg", "**/proxy/mock"], message: "Go through lib/proxy (vault-scoped key), never the raw 0G client." }] },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
