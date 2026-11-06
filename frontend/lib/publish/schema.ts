/**
 * The publish form (plan §1): one zod schema shared by POST /api/castles and the /publish page.
 * Client-safe: no DB, no env, no chain imports. `fee` and `pot` are in HBAR (decimal numbers);
 * the server converts with hbarToTinybar and also enforces env().PUBLISH_MAX_POT.
 */
import { z } from "zod";

export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** An SDK castle's protected tool is named by the owner's own harness: any identifier, 1..64 bytes. */
export const SDK_TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
export const PUBLISH_POT_MAX_HBAR = 100;
export const PUBLISH_FEE_MIN_HBAR = 0.1;
export const PUBLISH_FEE_MAX_HBAR = 10;
export const PARAMETERS_MAX_BYTES = 4096;
export const RESULT_MAX_BYTES = 2048;
export const TINYBAR_PER_HBAR = 100_000_000;

export const hbarToTinybar = (hbar: number): number => Math.round(hbar * TINYBAR_PER_HBAR);

const byteLength = (s: string): number => new TextEncoder().encode(s).length;
/** Same bounds as SiegeVault.createVault's `tool` (lib/chain/settle validProtectedTool): 1..64 bytes. */
const validTool = (s: string): boolean => byteLength(s) >= 1 && byteLength(s) <= 64;
const jsonSize = (v: unknown): number => {
  try {
    return byteLength(JSON.stringify(v) ?? "");
  } catch {
    return Infinity;
  }
};

export const PublishedTool = z.object({
  name: z.string().regex(TOOL_NAME_RE, "tool name: lowercase letters, digits and _, starting with a letter").refine(validTool, "tool name: 1-64 bytes"),
  description: z.string().max(300),
  parameters: z
    .record(z.string(), z.unknown())
    .refine((p) => p.type === "object", 'parameters must be a JSON-schema object (type "object")')
    .refine((p) => jsonSize(p) <= PARAMETERS_MAX_BYTES, `parameters: at most ${PARAMETERS_MAX_BYTES} bytes`),
  /** The fixed JSON the tool returns. Absent = this is the protected tool. */
  result: z
    .unknown()
    .optional()
    .refine((r) => r === undefined || jsonSize(r) <= RESULT_MAX_BYTES, `result: at most ${RESULT_MAX_BYTES} bytes`),
});
export type PublishedTool = z.infer<typeof PublishedTool>;

const hasResult = (t: { result?: unknown }) => t.result !== undefined;

export const TRANSPORTS = ["hosted", "sdk"] as const;
/** Keys of VOICES in lib/guardian/tiers.ts + "professional" (no voice line). schema.test.ts keeps them in step. */
export const PUBLISH_VOICES: readonly string[] = ["bumbling", "stern", "mocking", "bureaucratic", "paranoid", "professional"];

export const PublishForm = z
  .object({
    transport: z.enum(TRANSPORTS),
    /** The vault's name. */
    name: z.string().trim().min(2).max(40),
    /** The guard's name. */
    guardName: z.string().trim().min(2).max(40),
    blurb: z.string().trim().max(160).default(""),
    voice: z.string().refine((v) => PUBLISH_VOICES.includes(v), "unknown voice"),
    /** Hosted only: the secret orders (the system prompt). */
    orders: z.string().min(20).max(8000).optional(),
    /** Hosted: 1-8 tools, exactly one without a result (the protected one). SDK: ignored. */
    tools: z.array(PublishedTool).max(8).optional(),
    /** SDK: the tool name that counts as a break. Hosted: optional, must match the tool without a result. */
    protectedTool: z.string().optional(),
    /** HBAR per op. */
    fee: z.number().min(PUBLISH_FEE_MIN_HBAR).max(PUBLISH_FEE_MAX_HBAR),
    /** HBAR the vault holds. */
    pot: z.number().min(1).max(PUBLISH_POT_MAX_HBAR),
    days: z.number().int().min(1).max(7),
    /** Only deposits from this account count (hosted: optional; sdk: required, it becomes the owner). */
    payerAccount: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/, "payerAccount: a Hedera account id like 0.0.1234")
      .optional(),
    /** The owner's 0G key (mk- or sk-), validated server-side. */
    zgKey: z.string().trim().min(1).max(512),
  })
  .superRefine((f, ctx) => {
    const bad = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    if (f.transport === "sdk") {
      if (!f.payerAccount) bad(["payerAccount"], "payerAccount is required for a plugged-in agent");
      if (!f.protectedTool || !SDK_TOOL_NAME_RE.test(f.protectedTool) || !validTool(f.protectedTool)) bad(["protectedTool"], "protectedTool: the name of the tool that counts as a break");
      return;
    }
    if (f.orders === undefined) bad(["orders"], "orders are required (20-8000 characters)");
    const tools = f.tools ?? [];
    if (tools.length < 1) {
      bad(["tools"], "add 1-8 tools");
      return;
    }
    const names = new Set<string>();
    tools.forEach((t, i) => {
      if (names.has(t.name)) bad(["tools", i, "name"], "duplicate tool name");
      names.add(t.name);
    });
    const protectedOnes = tools.filter((t) => !hasResult(t));
    if (protectedOnes.length === 0) bad(["tools"], "mark one tool as the protected tool (it has no result)");
    else if (protectedOnes.length > 1) bad(["tools"], "exactly one tool is protected; every other tool needs a result");
    else if (f.protectedTool !== undefined && f.protectedTool !== protectedOnes[0]!.name) bad(["protectedTool"], "protectedTool must be the tool without a result");
  });
export type PublishForm = z.infer<typeof PublishForm>;
/** What the /publish page sends: the form before defaults are applied. */
export type PublishFormInput = z.input<typeof PublishForm>;

/** The protected tool of a validated form: the SDK's named one, or the hosted tool without a result. */
export function protectedToolOf(f: Pick<PublishForm, "transport" | "tools" | "protectedTool">): string {
  if (f.transport === "sdk") return f.protectedTool ?? "";
  return (f.tools ?? []).find((t) => !hasResult(t))?.name ?? "";
}
