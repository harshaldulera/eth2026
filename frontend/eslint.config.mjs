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
 * Exception: scripts/guardian-fixtures.ts (Lane B's offline fixture runner) calls the 0G guardian
 * directly with explicit profiles (respondAs), not castles, so it never plays a siege.
 * Rule two: lib/guardian/** reaches the model only through lib/proxy with the castle's vault-scoped
 * key (proxy.issueKey); it may not read any *KEY / *SECRET / *TOKEN env var (only lib/proxy holds the
 * team key and its config).
 * Raw 0G client (lib/proxy/zg, lib/proxy/mock): only lib/proxy may call it, so every guardian request
 * goes through the vault-scoped key and leaves a proxy record.
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
const GUARDIAN_KEY_MSG = "lib/guardian reaches the model only through lib/proxy (vault-scoped key from proxy.issueKey); never read a key/secret env var (only lib/proxy may).";
const RAW_ZG_PATTERNS = [
  {
    group: ["@/lib/proxy/zg", "@/lib/proxy/mock", "**/proxy/zg", "**/proxy/mock"],
    message: "Only lib/proxy may call the raw 0G client: go through lib/proxy (vault-scoped key) so every request leaves a proxy record.",
  },
];
const GUARDIAN_FIXTURE_RUNNER = "scripts/guardian-fixtures.ts";

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
            { group: ["@/lib/arkiv/client", "@/lib/arkiv/outbox", "**/lib/arkiv/client", "**/lib/arkiv/outbox"], message: "lib/arkiv/client and outbox hold the Arkiv writer key. Import @/lib/arkiv (the port) instead." },
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
    ignores: ["**/*.test.{ts,tsx}", "lib/transport/**", "lib/guardian/**", "lib/proxy/**", GUARDIAN_FIXTURE_RUNNER],
    rules: {
      "no-restricted-imports": ["error", { patterns: [...GUARDIAN_PATTERNS, ...RAW_ZG_PATTERNS] }],
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
  // Lane B boundaries (tech plan). Flat config replaces a rule's options per file rather than merging
  // them, so each block below carries every pattern its files need (Lane A's guardian seam included).
  // lib/siege reaches guardians only through lib/transport, with its own message.
  {
    files: ["lib/siege/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ ...GUARDIAN_PATTERNS[0], message: "lib/siege must call guardians through lib/transport (GuardianTransport)." }, ...RAW_ZG_PATTERNS] },
      ],
    },
  },
  // lib/guardian, lib/transport and the fixture runner may touch the guardian, never the raw 0G client.
  {
    files: ["lib/guardian/**/*.{ts,tsx}", "lib/transport/**/*.{ts,tsx}", GUARDIAN_FIXTURE_RUNNER],
    rules: {
      "no-restricted-imports": ["error", { patterns: RAW_ZG_PATTERNS }],
    },
  },
  // Tests in worker/ and scripts/ are exempt from the guardian seam (block above) but, as on lane-b,
  // still may not call the raw 0G client.
  {
    files: ["worker/**/*.test.{ts,tsx}", "scripts/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: RAW_ZG_PATTERNS }],
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
