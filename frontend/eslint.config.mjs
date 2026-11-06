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
