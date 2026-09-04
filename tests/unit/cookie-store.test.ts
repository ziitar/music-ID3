import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCookieStore, type SafeStorage } from "../../electron/services/cookie-store";

const temporaryDirectories: string[] = [];

function fakeSafeStorage(): SafeStorage {
  return {
    encryptString(value) {
      return Buffer.from(`encrypted:${value}`, "utf8");
    },
    decryptString(value) {
      return value.toString("utf8").replace("encrypted:", "");
    }
  };
}

async function createTempDir() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "music-id3-cookie-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("cookie store", () => {
  it("encrypts a provider cookie and returns it only through the store", async () => {
    const userDataPath = await createTempDir();
    const store = createCookieStore({ safeStorage: fakeSafeStorage(), userDataPath });

    await store.set("qq", "uin=o123; skey=secret");

    expect(await store.get("qq")).toBe("uin=o123; skey=secret");
    expect(await store.redacted("qq")).toBe("configured");
    expect(await readFile(store.filePath(), "utf8")).not.toContain("skey=secret");
    expect(await readdir(userDataPath)).toEqual(["provider-cookies.json"]);
  });

  it("keeps Cookies separated by provider and reports an empty provider as unconfigured", async () => {
    const store = createCookieStore({ safeStorage: fakeSafeStorage(), userDataPath: await createTempDir() });

    await store.set("netease", "MUSIC_U=netease-secret");
    await store.set("qq", "uin=o123; skey=qq-secret");

    expect(await store.get("netease")).toBe("MUSIC_U=netease-secret");
    expect(await store.get("qq")).toBe("uin=o123; skey=qq-secret");
    expect(await store.redacted("netease")).toBe("configured");
    expect(await store.redacted("qq")).toBe("configured");
    expect(await store.redacted("qq")).not.toContain("qq-secret");
  });

  it("preserves concurrent updates for different providers", async () => {
    const store = createCookieStore({ safeStorage: fakeSafeStorage(), userDataPath: await createTempDir() });

    await Promise.all([
      store.set("netease", "MUSIC_U=netease-secret"),
      store.set("qq", "uin=o123; skey=qq-secret")
    ]);

    expect(await store.get("netease")).toBe("MUSIC_U=netease-secret");
    expect(await store.get("qq")).toBe("uin=o123; skey=qq-secret");
  });

  it("clears an empty provider Cookie and reports it as unconfigured", async () => {
    const store = createCookieStore({ safeStorage: fakeSafeStorage(), userDataPath: await createTempDir() });
    await store.set("qq", "uin=o123; skey=qq-secret");

    await store.set("qq", "");

    expect(await store.get("qq")).toBeUndefined();
    expect(await store.redacted("qq")).toBe("unconfigured");
    expect(await readFile(store.filePath(), "utf8")).not.toContain("qq-secret");
  });
});
