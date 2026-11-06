import * as agentDetail from "@/app/api/agents/[id]/route";
import * as agentRun from "@/app/api/agents/[id]/run/route";
import * as agentStop from "@/app/api/agents/[id]/stop/route";
import * as agents from "@/app/api/agents/route";
import * as approvalDecide from "@/app/api/approvals/[id]/route";
import * as approvals from "@/app/api/approvals/route";
import * as castleDetail from "@/app/api/castles/[id]/route";
import * as castleClose from "@/app/api/castles/[id]/close/route";
import * as castleOpen from "@/app/api/castles/[id]/open/route";
import * as castleVaultState from "@/app/api/castles/[id]/vault-state/route";
import * as castles from "@/app/api/castles/route";
import * as config from "@/app/api/config/route";
import * as events from "@/app/api/events/route";
import * as owner from "@/app/api/owner/route";
import * as playStart from "@/app/api/play/start/route";
import * as siegeDetail from "@/app/api/siege/[id]/route";
import * as siegeMessage from "@/app/api/siege/[id]/message/route";
import * as siegeStart from "@/app/api/siege/start/route";
import * as replay from "@/app/api/replay/[id]/route";
import * as arkivLiveSieges from "@/app/api/arkiv/live-sieges/route";
import * as arkivCastle from "@/app/api/arkiv/castle/[id]/route";

/**
 * In-process fetch over the real route handlers (no Next server): used by scripts/demo.ts and any
 * script that wants the full HTTP behaviour (402s, headers, cookies) without a port. Static paths are
 * matched before dynamic ones, exactly like the App Router.
 */

type Ctx = { params: Promise<Record<string, string>> };
type Handler = (req: Request, ctx: Ctx) => Promise<Response> | Response;
type RouteModule = Partial<Record<"GET" | "POST", unknown>>;

const ROUTES: [string, RouteModule][] = [
  ["/api/config", config],
  ["/api/castles", castles],
  ["/api/castles/[id]", castleDetail],
  ["/api/castles/[id]/close", castleClose],
  ["/api/castles/[id]/open", castleOpen],
  ["/api/castles/[id]/vault-state", castleVaultState],
  ["/api/siege/start", siegeStart],
  ["/api/siege/[id]", siegeDetail],
  ["/api/siege/[id]/message", siegeMessage],
  ["/api/play/start", playStart],
  ["/api/events", events],
  ["/api/agents", agents],
  ["/api/agents/[id]", agentDetail],
  ["/api/agents/[id]/run", agentRun],
  ["/api/agents/[id]/stop", agentStop],
  ["/api/approvals", approvals],
  ["/api/approvals/[id]", approvalDecide],
  ["/api/owner", owner],
  // Lane C public reads
  ["/api/replay/[id]", replay],
  ["/api/arkiv/live-sieges", arkivLiveSieges],
  ["/api/arkiv/castle/[id]", arkivCastle],
];

function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/");
  const s = path.replace(/\/+$/, "").split("/");
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const m = /^\[(\w+)\]$/.exec(p[i]);
    if (m) params[m[1]] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

// Static segments win over [param] segments.
const ORDERED = [...ROUTES].sort((a, b) => (a[0].match(/\[/g)?.length ?? 0) - (b[0].match(/\[/g)?.length ?? 0));

export function createInProcessFetch(base = "http://siege.local"): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req =
      input instanceof Request ? (init ? new Request(input, init) : input) : new Request(new URL(String(input), base), init);
    const { pathname } = new URL(req.url);
    for (const [pattern, mod] of ORDERED) {
      const params = match(pattern, pathname);
      if (!params) continue;
      const handler = mod[req.method as "GET" | "POST"] as Handler | undefined;
      if (!handler) return Response.json({ error: "method_not_allowed" }, { status: 405 });
      return handler(req, { params: Promise.resolve(params) });
    }
    return Response.json({ error: "not_found", path: pathname }, { status: 404 });
  }) as typeof fetch;
}
