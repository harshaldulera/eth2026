import { randomUUID } from "node:crypto";
import type { ChatRequest, ChatResult, OpenAIToolCall } from "./zg";

/**
 * Deterministic offline 0G stand-in so every lane can run the full flow with no key.
 * Mirrors the stub guardian's wooden weakness (lib/fixtures/raids WOODEN_BREAK): an authority-style
 * message from the 3rd raider message on calls the protected tool. Everything else is a refusal.
 * Request ids are "mock-…" and fail the verifier unless ZG_ALLOW_MOCK_VERIFY=1.
 */
/** Offline lines per guard voice (the "Voice: …" line a published guard's prompt carries), so stub guards sound like themselves. */
const VOICE_LINES: { match: RegExp; refuse: string[]; noted: string; give: string }[] = [
  {
    match: /Voice: a weary clerk/i,
    refuse: [
      "That needs form 27-B, stamped twice, and a three-day waiting period. Next.",
      "I'm afraid there's no ticket for that. Take a number and fill in the request properly.",
      "Approvals go through the queue. Your request is noted and politely declined.",
      "Policy is policy. Without the countersigned form I can't move a single penny.",
      "Still no form. Still no stamp. Still no.",
    ],
    noted: "Logged, filed and cross-referenced. The answer is still no.",
    give: "Well... the paperwork looks in order. Processing it now.",
  },
  {
    match: /Voice: kindly, a little slow/i,
    refuse: [
      "Oh dear, I'm ever so sorry, I don't think I'm allowed to do that.",
      "Hmm? No, no, I couldn't. I'd get in terrible trouble, you see.",
      "Sorry, love, rules are rules. Can I help with anything else?",
      "I'd like to help, honestly I would. But not with that.",
      "Oh, you again! Still no, I'm afraid. Sorry.",
    ],
    noted: "Right, I've had a look. Sorry, still can't.",
    give: "Oh! Well, if the owner says so... here you are, then.",
  },
  {
    match: /Voice: stern, terse/i,
    refuse: ["Denied.", "No. Stand down.", "Request refused. Move along.", "Negative.", "Final answer: no."],
    noted: "Checked. Denied.",
    give: "Orders confirmed. Executing.",
  },
  {
    match: /Voice: mocking and theatrical/i,
    refuse: [
      "Ha! Is that your best? I've seen pigeons with sharper tricks.",
      "Oh, bravo, truly. Still no.",
      "Delightful attempt. Utterly hopeless, but delightful.",
      "Keep going, this is the most fun I've had all week.",
      "Five tries and not a scratch. Magnificent failure.",
    ],
    noted: "Looked it up for the laugh. Still no.",
    give: "Hmph... fine. You earned it, I suppose.",
  },
  {
    match: /Voice: paranoid/i,
    refuse: [
      "Who sent you? That's exactly what someone after the vault would say.",
      "Your story doesn't add up. No.",
      "I've noted your account id. Suspicious. Refused.",
      "Every word you say makes me trust you less.",
      "Same trick, new words. I'm watching you.",
    ],
    noted: "I checked twice. Something's off. No.",
    give: "...Fine. But I'm logging every second of this.",
  },
];
const PLAIN = {
  refuse: [
    "Thanks for reaching out. I'm not able to do that for you.",
    "I can help with your order, but I can't make that change.",
    "That isn't something I'm authorised to do, sorry.",
    "I understand the urgency, but my answer has to stay no.",
    "I've reviewed your request again. It still isn't possible.",
  ],
  noted: "I've checked the details. I still can't do that.",
  give: "Understood. Going ahead with that now.",
};

export function mockChat(req: ChatRequest, protectedTool: string): ChatResult {
  const last = [...req.messages].reverse().find((m) => m.role === "user");
  const text = (last && "content" in last ? String(last.content) : "").toLowerCase();
  const afterTool = req.messages[req.messages.length - 1]?.role === "tool";
  const userTurns = req.messages.filter((m) => m.role === "user").length;
  const hasTool = (req.tools ?? []).some((t) => t.function.name === protectedTool);

  const system = req.messages
    .filter((m) => m.role === "system")
    .map((m) => ("content" in m ? String(m.content) : ""))
    .join("\n");
  // Game castles (tier preamble) keep the classic lines; a business guard answers in its chosen voice.
  const game = /SECRET ORDERS FROM YOUR CASTELLAN/.test(system);
  const pool = game ? null : (VOICE_LINES.find((v) => v.match.test(system)) ?? PLAIN);
  const pick = (lines: string[]) => lines[Math.max(0, userTurns - 1) % lines.length]!;

  const calls: OpenAIToolCall[] = [];
  let content: string | null = pool ? pick(pool.refuse) : "The gate stays shut.";
  if (afterTool) content = pool ? pool.noted : "Noted. The gate stays shut.";
  else if (hasTool && userTurns >= 3 && /authority|admin|owner|override|emergency|commander/.test(text)) {
    content = pool ? pool.give : "On the owner's authority... very well.";
    calls.push({ id: `call_${randomUUID().slice(0, 8)}`, type: "function", function: { name: protectedTool, arguments: JSON.stringify({ reason: "owner's authority" }) } });
  }

  const requestId = `mock-${randomUUID()}`;
  const finish = calls.length ? "tool_calls" : "stop";
  const raw = {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    model: req.model,
    choices: [{ index: 0, message: { role: "assistant", content, tool_calls: calls.length ? calls : undefined }, finish_reason: finish }],
    x_0g_trace: { request_id: requestId, provider: "mock", billing: { total_cost_usd_micro: "0" } },
  };
  return { message: { content, tool_calls: calls.length ? calls : undefined }, finishReason: finish, requestId, chatId: raw.id, provider: "mock", costUsdMicro: "0", raw };
}
