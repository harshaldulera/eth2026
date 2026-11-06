import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Key-handling guard rails:
 *  - app/** and components/** (anything Next serves) may not import the worker, and may not touch
 *    VERIFIER_KEY or the verifier signer. Only worker/ signs Releases.
 */
const VERIFIER_MSG = "The verifier key is worker-only (worker/signer.ts). Never read VERIFIER_KEY or sign Releases from app/ or components/.";

/**
 * Guardian seam (plan: "Two decisions that cannot be deferred"): the siege state machine talks only
 * to GuardianTransport. Only lib/transport/** may import lib/guardian; app/, components/, lib/siege/,
 * lib/agents/ and worker/ go through @/lib/transport. (Test files are exempt: they may poke stubs.)
 */
const GUARDIAN_MSG = "Guardian replies go through @/lib/transport (GuardianTransport). Only lib/transport/** may import lib/guardian.";
const GUARDIAN_PATTERNS = [
  { group: ["@/lib/guardian", "@/lib/guardian/*", "**/lib/guardian", "**/lib/guardian/*", "../guardian", "../guardian/*"], message: GUARDIAN_MSG },
];

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
            ...GUARDIAN_PATTERNS,
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
  {
    files: ["lib/siege/**/*.{ts,tsx}", "lib/agents/**/*.{ts,tsx}", "worker/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: GUARDIAN_PATTERNS }],
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
