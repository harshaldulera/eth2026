import { afterEach, describe, expect, it } from "vitest";
import { env, resetEnv } from "./env";

describe("env", () => {
  const saved = process.env.DATABASE_URL;
  afterEach(() => {
    process.env.DATABASE_URL = saved;
    resetEnv();
  });

  it("treats an empty KEY= line as unset, so the default applies", () => {
    process.env.DATABASE_URL = "";
    resetEnv();
    expect(env().DATABASE_URL).toBe("file:./data/siege.db");
  });
});
