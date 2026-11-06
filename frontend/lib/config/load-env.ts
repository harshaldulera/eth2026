/**
 * Load .env / .env.local the same way `next dev` does. Import this FIRST in any
 * standalone process (worker, scripts) — Next routes load env on their own.
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
