import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetPrefsForTest, bootstrapScript, DEFAULT_PREFS, getPrefs, getServerPrefs, onPrefChange, parsePref, readPrefs,
  setPref, subscribePrefs,
} from "./prefs";

function fakeStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}
function fakeRoot(init: Record<string, string> = {}) {
  const a = new Map(Object.entries(init));
  return {
    getAttribute: (n: string) => a.get(n) ?? null,
    setAttribute: (n: string, v: string) => void a.set(n, v),
    removeAttribute: (n: string) => void a.delete(n),
    a,
  };
}

afterEach(() => __resetPrefsForTest());

describe("parsePref / readPrefs", () => {
  it("parses skins and flags, rejects junk", () => {
    expect(parsePref("skin", "NEON")).toBe("neon");
    expect(parsePref("skin", "vapor")).toBeUndefined();
    expect(parsePref("crt", "off")).toBe(false);
    expect(parsePref("crt", "on")).toBe(true);
    expect(parsePref("calm", "1")).toBe(true);
    expect(parsePref("muted", "true")).toBe(true);
    expect(parsePref("muted", "maybe")).toBeUndefined();
  });

  it("defaults with nothing stored", () => {
    expect(readPrefs(null)).toEqual(DEFAULT_PREFS);
    expect(getServerPrefs()).toEqual({ skin: "neon", crt: true, muted: false, calm: false });
  });

  it("query beats storage, storage beats defaults", () => {
    const s = fakeStorage({ "siege.skin": "neon", "siege.crt": "off", "siege.sfx.muted": "1" });
    expect(readPrefs(s)).toEqual({ skin: "neon", crt: false, muted: true, calm: false });
    expect(readPrefs(s, "?skin=crt&crt=on&calm=1")).toEqual({ skin: "crt", crt: true, muted: true, calm: true });
    expect(readPrefs(s, "?skin=bogus")).toMatchObject({ skin: "neon" });
  });

  it("survives a throwing storage", () => {
    const bad = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(readPrefs(bad, "")).toEqual(DEFAULT_PREFS);
  });
});

describe("store", () => {
  it("seeds from <html> attributes the bootstrap script set", () => {
    const storage = fakeStorage({ "siege.sfx.muted": "1" });
    const root = fakeRoot({ "data-skin": "neon", "data-crt": "off", "data-calm": "1" });
    __resetPrefsForTest(() => ({ storage, root }));
    expect(getPrefs()).toEqual({ skin: "neon", crt: false, muted: true, calm: true });
  });

  it("setPref persists, writes attributes, notifies once, and keeps snapshots stable", () => {
    const storage = fakeStorage();
    const root = fakeRoot();
    __resetPrefsForTest(() => ({ storage, root }));
    const first = getPrefs();
    expect(getPrefs()).toBe(first);
    const l = vi.fn();
    const side = vi.fn();
    subscribePrefs(l);
    onPrefChange(side);

    setPref("skin", "crt");
    expect(storage.m.get("siege.skin")).toBe("crt");
    expect(root.a.get("data-skin")).toBe("crt");
    expect(root.a.get("data-crt")).toBe("on");
    expect(l).toHaveBeenCalledTimes(1);
    expect(side).toHaveBeenCalledWith("skin", expect.objectContaining({ skin: "crt" }));

    setPref("skin", "crt");
    expect(l).toHaveBeenCalledTimes(1);

    setPref("crt", false);
    expect(root.a.get("data-crt")).toBe("off");
    expect(storage.m.get("siege.crt")).toBe("off");

    setPref("calm", true);
    expect(root.a.get("data-calm")).toBe("1");
    setPref("calm", false);
    expect(root.a.has("data-calm")).toBe(false);

    setPref("muted", true);
    expect(storage.m.get("siege.sfx.muted")).toBe("1");
    expect(getPrefs()).toEqual({ skin: "crt", crt: false, muted: true, calm: false });
  });

  it("still applies when storage throws", () => {
    const storage = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    const root = fakeRoot();
    __resetPrefsForTest(() => ({ storage, root }));
    setPref("skin", "crt");
    expect(getPrefs().skin).toBe("crt");
    expect(root.a.get("data-skin")).toBe("neon");
  });
});

describe("bootstrapScript", () => {
  function run(search: string, stored: Record<string, string>, pathname = "/") {
    const root = fakeRoot({ "data-skin": "neon", "data-crt": "on" });
    const storage = fakeStorage(stored);
    const fn = new Function("document", "location", "localStorage", "URLSearchParams", bootstrapScript());
    fn({ documentElement: root }, { search, pathname }, storage, URLSearchParams);
    return Object.fromEntries(root.a);
  }

  it("applies stored prefs", () => {
    expect(run("", { "siege.skin": "neon", "siege.crt": "off" })).toEqual({ "data-skin": "neon", "data-crt": "off" });
  });
  it("lets the query win and honours calm", () => {
    expect(run("?skin=neon&crt=0&calm=1", { "siege.skin": "crt" })).toEqual({ "data-skin": "neon", "data-crt": "off", "data-calm": "1" });
  });
  it("pins the landing page to neon, whatever was saved or asked for", () => {
    expect(run("", { "siege.skin": "crt" }, "/welcome")["data-skin"]).toBe("neon");
    expect(run("?skin=crt", {}, "/welcome/")["data-skin"]).toBe("neon");
    expect(run("", { "siege.skin": "crt" }, "/hall")["data-skin"]).toBe("crt");
  });
  it("ignores junk", () => {
    expect(run("?skin=<script>", { "siege.crt": "sideways" })).toEqual({ "data-skin": "neon", "data-crt": "on" });
  });
  it("agrees with readPrefs", () => {
    const stored = { "siege.skin": "neon", "siege.calm": "1" };
    const attrs = run("?crt=off", stored);
    const p = readPrefs(fakeStorage(stored), "?crt=off");
    expect(attrs["data-skin"]).toBe(p.skin);
    expect(attrs["data-crt"]).toBe(p.crt ? "on" : "off");
    expect(attrs["data-calm"] === "1").toBe(p.calm);
  });
});
