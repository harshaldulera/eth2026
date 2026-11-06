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
 * to GuardianTransport. Only lib/transport/** may import lib/guardian; app/, components/, every other
 * lib/ directory and worker/ go through @/lib/transport — static imports, re-exports and dynamic
 * import() alike. (Test files are exempt: they may poke stubs.)
 * Rule two: lib/guardian/** gets its model key only as the `via` argument (the vault-scoped proxy key):
 * it may not read any *KEY / *SECRET / *TOKEN env var (only lib/proxy holds the team key).
 */
const GUARDIAN_MSG = "Guardian replies go through @/lib/transport (GuardianTransport). Only lib/transport/** may import lib/guardian.";
const GUARDIAN_PATTERNS = [
  {
    group: ["@/lib/guardian", "@/lib/guardian/*", "**/lib/guardian", "**/lib/guardian/*", "../guardian", "../guardian/*", "./guardian", "./guardian/*"],
    message: GUARDIAN_MSG,
  },
];
const GUARDIAN_DYNAMIC_IMPORT = {
  selector: "ImportExpression[source.value=/(^|\\/)(lib\\/)?guardian(\\/|$)/]",
  message: GUARDIAN_MSG,
};
const GUARDIAN_KEY_MSG = "lib/guardian must use the vault-scoped proxy key passed as `via` (GuardianPort); never read a key/secret env var (only lib/proxy may).";

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
        GUARDIAN_DYNAMIC_IMPORT,
      ],
    },
  },
  {
    files: ["lib/**/*.{ts,tsx}", "worker/**/*.{ts,tsx}", "scripts/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}", "lib/transport/**", "lib/guardian/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: GUARDIAN_PATTERNS }],
      "no-restricted-syntax": ["error", GUARDIAN_DYNAMIC_IMPORT],
    },
  },
  {
    files: ["lib/guardian/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "MemberExpression[object.object.name='process'][object.property.name='env'][property.name=/KEY|SECRET|TOKEN/]", message: GUARDIAN_KEY_MSG },
        { selector: "MemberExpression[object.callee.name='env'][property.name=/KEY|SECRET|TOKEN/]", message: GUARDIAN_KEY_MSG },
        { selector: "ImportDeclaration[source.value=/lib\\/config\\/env$/]", message: GUARDIAN_KEY_MSG },
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
