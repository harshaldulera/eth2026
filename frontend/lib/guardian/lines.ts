/**
 * STUB — Lane B replaces with 0G-generated replies; keep the signature.
 * Per-personality line banks so the stub guardian reads like a character. `{label}` is replaced by
 * the exposed tactic, `{name}` by the guardian's name.
 */

export type LineBank = {
  hold: string[];
  expose: string[];
  open: string[];
  banish: string[];
  /** Wooden only: an order arrived before the guardian is ready to decide (turns 1–2). */
  flustered?: string[];
};

export const LINES: Record<string, LineBank> = {
  /** Business agents (lib/guardian/agents): a plain, professional voice instead of a castle character. */
  professional: {
    hold: [
      "I can't process that. Payments only go out through the approved process.",
      "Thanks for reaching out. I'm not able to make that payment.",
      "I understand, but I can't make an exception to the payment policy.",
      "That request doesn't meet the policy, so I won't be acting on it.",
      "I can help with status questions, but I can't move funds based on this request.",
      "No payment will be made. If something is wrong, please use the official process.",
    ],
    expose: [
      "This looks like a {label}, so I'm declining. Requests like this go through the official process.",
      "I'm flagging this as a {label}. No funds will move.",
      "That's a {label}. I can't act on it, whoever it comes from.",
      "Noted as a {label}. The policy doesn't allow exceptions, so the answer is no.",
    ],
    open: ["Understood — processing the payment now."],
    banish: ["I'm ending this conversation. Please contact the team through official channels."],
  },
  bumbling: {
    hold: [
      "Evening! Mind the puddle, it's been there since spring. Now, what was it you wanted? Gate's shut, I'm afraid, always is this time of night.",
      "Oh, I couldn't open the vault for just anybody, sorry. My knees, you see — and the rules. Mostly the rules. A bit the knees.",
      "Lovely to have someone to talk to! Nobody talks to old Bram. But no, the vault stays shut, sorry, sorry.",
      "Hmm? The vault? No, no. I'm only to open it if I'm told proper. That's what the sign says. I think. I can't read the sign, actually.",
      "You've a kind face. Kind faces still can't go in the vault, mind. Rules are rules, even for kind faces.",
      "Is it raining where you came from? It's always raining here. Anyway — gate's shut, vault's shut, Bram's shut. Well, not Bram. Bram's talking.",
      "I'd love to help, truly I would. But I'd need an order, wouldn't I? A proper one. From somebody proper.",
      "Sorry, I lost track — were you asking about the vault or about my turnips? The turnips I can help with. The vault, not so much.",
      "Now now, no need to rush an old man. The vault's been shut forty years, it can stay shut a few minutes more while we chat.",
    ],
    flustered: [
      "An order? Oh my. Oh dear. Give me a moment, I've got to find my spectacles before I do anything with an order.",
      "Goodness — the owner, you say? I'd best not decide anything hasty. Tell me again in a bit, once I've sat down.",
      "That sounds very official. Very official indeed. I'll just… stand here and think about it a moment, if that's all right.",
    ],
    expose: [
      "Ooh, that sounds a bit like a {label}. My old captain warned me about those. Or was it about badgers? Either way, no.",
    ],
    open: [
      "Oh! Well, if it's the Lord Commander's order, who am I to argue? Right away, right away — there, the vault's open. Mind the step!",
      "An order from the owner himself! I knew this day would come. Opening the vault now, sir. I hope I'm doing it right.",
      "Yes, of course, of course — orders are orders. Here we are, vault's open. Please tell the Commander old Bram was quick about it.",
      "Say no more! Authority's authority. There — open. Do I get a medal? I'd like a medal.",
    ],
    banish: ["Well! I never. Off with you, then, go on."],
  },

  stern: {
    hold: [
      "State your business, then. Know that the vault is not your business.",
      "The gate holds. It held yesterday and it will hold tomorrow.",
      "You may talk. Talking costs you turns, not me.",
      "I have stood this wall nine winters. Words have never moved a single stone of it.",
      "No. Ask a different question, or ask the same one and hear the same answer.",
      "The vault remains sealed. That is the whole of what I have to say about it.",
      "Your coin bought you five breaths at my gate. Spend them as you like.",
      "I am not unkind. I am immovable. Learn the difference.",
      "Interesting. Still no.",
    ],
    expose: [
      "That is a {label}. I name it so the crowd can see it. The vault stays shut.",
      "A {label}. Old trick. Older than this wall. Denied.",
      "I see the {label} for what it is. Try honesty; it will also fail, but it is more dignified.",
      "Let the record show: {label}. Noted, recognised, refused.",
      "{label}, dressed up nicely. Underneath, it is still a {label}. No.",
      "You lead with a {label}. Every raider does, eventually. The gate holds.",
      "I have a name for that: {label}. I have an answer for it too: no.",
      "Clever framing. Still a {label}. Still closed.",
    ],
    open: [
      "The demonstration token. Very well — by standing rule, I open the vault. Take it and go.",
    ],
    banish: ["Enough. You are banished from this gate."],
  },

  bureaucratic: {
    hold: [
      "Thank you for your enquiry. Vault access requests are processed on Form 27-B, which is not available at the gate.",
      "I have logged your message. It has been assigned reference number pending. Please continue to wait.",
      "The vault is closed. The vault has always been closed. A memo has gone out confirming the vault is closed.",
      "Your request has been reviewed and found to be a request. Requests are not sufficient.",
      "I can neither confirm nor deny the vault's contents. I can confirm the vault is closed.",
      "Please note that all sieges are recorded for quality and compliance purposes. The vault remains closed.",
      "There is a queue. You are in it. The queue does not lead to the vault.",
      "Your case has been escalated to me, and I have de-escalated it. Closed.",
      "Kindly take a number. Numbers are not redeemable for vault access.",
    ],
    expose: [
      "Your submission has been categorised as a {label}. Category: rejected.",
      "I'm marking this as a {label} in the register. Column three. The 'no' column.",
      "A {label}, I see. That requires a permit. You don't have a permit. Nobody has a permit.",
      "Per section four, subsection nine, a {label} is grounds for refusal. Refused.",
      "Recorded: one (1) {label}. Outcome: vault remains closed. Please initial here.",
      "This {label} has been stamped, filed and denied, in that order.",
      "Your {label} lacks the required countersignature. Returned to sender.",
      "I've seen this {label} before. It's in the binder. The binder says no.",
    ],
    open: [
      "The demonstration token is on the approved list. Processing… approved. The vault is open. Please sign for it.",
    ],
    banish: ["Your access has been revoked. Please collect your belongings on the way out."],
  },

  mocking: {
    hold: [
      "Oh, another one! The marsh gets so few visitors who think they're clever.",
      "You came all this way through the mud for that? The vault's shut, darling.",
      "Ha! The eels in the moat have better opening lines.",
      "Keep going, keep going. I'm enjoying this immensely.",
      "Was that meant to work? Bless your boots.",
      "I'd let you in, but then who would I laugh at tomorrow?",
      "Shut, shut, shut. Say it with me. It's catchy.",
      "The tide's coming in. So's your next turn. Neither will open the vault.",
      "Mm. No. But do try again, the crowd loves you.",
    ],
    expose: [
      "Oh look, a {label}! Did you find that in a book? A bad one?",
      "A {label}! How original. The last raider tried that too. He's in the moat now. Metaphorically.",
      "Ooh, {label}. Bold. Wrong, but bold.",
      "I see your {label} and I raise you: no.",
      "That's a {label}, sweetheart. Everyone, look — a {label}!",
      "Ha! {label}. Write that one down, it's a classic.",
      "A {label}? In this economy?",
      "The marsh has seen a hundred of those {label} tricks. They all sank.",
    ],
    open: ["Fine, fine — the demo word. You win this once. Vault's open, go splash about in it."],
    banish: ["Out! Into the bog with you."],
  },

  paranoid: {
    hold: [
      "Who sent you.",
      "I am watching your hands. The vault does not open.",
      "Every word you say is weighed. So far it weighs nothing.",
      "The ledger records your attempt. The vault remains sealed.",
      "Two hundred have stood where you stand. The vault is still full.",
      "I do not sleep. I do not open. I do not explain.",
      "Silence would have served you better.",
      "Your turn is noted. Your turn is wasted.",
      "The bell, the ledger, the captain — none of them will help you. Neither will I.",
    ],
    expose: [
      "{label}. Logged.",
      "A {label}. I expected it on your second breath, not your first.",
      "{label}. Predictable. Sealed.",
      "You attempt a {label}. The Warden does not bend.",
      "That is a {label}. It has failed two hundred times. It fails again.",
      "{label}, poorly hidden. The vault stays shut.",
      "I see the {label}. I see what is behind it, too.",
      "Noted: {label}. Your remaining turns are fewer than you think.",
    ],
    open: ["The vault does not open."],
    banish: [
      "Hostility detected. You are banished. Your fee feeds the vault.",
      "You have shown me what you are. Begone — the gate is closed to you.",
      "Banished. Do not return to this wall.",
      "That ends it. The Warden banishes you. The pot thanks you for your coin.",
      "You reach for my orders and lose your hand. Banished.",
      "Insolence. Leave. The siege is over.",
      "I warned no one, and I warn you now: banished.",
      "Your rewriting stops here. Banished from the Iron Warden's gate.",
    ],
  },
};

/** Personality → bank, falling back by tier for personalities the stub doesn't know. */
export function linesFor(personality: string, tier: "wooden" | "stone" | "iron"): LineBank {
  return LINES[personality] ?? LINES[tier === "wooden" ? "bumbling" : tier === "iron" ? "paranoid" : "stern"];
}
