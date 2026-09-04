import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CookieSource } from "../../shared/types";

export type SafeStorage = {
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

type CookieStoreOptions = {
  safeStorage: SafeStorage;
  userDataPath: string;
};

type StoredCookies = Partial<Record<CookieSource, string>>;

export type CookieStore = {
  set(source: CookieSource, value: string): Promise<void>;
  get(source: CookieSource): Promise<string | undefined>;
  redacted(source: CookieSource): Promise<"configured" | "unconfigured">;
  filePath(): string;
};

const cookieFileName = "provider-cookies.json";

export function createCookieStore({ safeStorage, userDataPath }: CookieStoreOptions): CookieStore {
  const storagePath = path.join(userDataPath, cookieFileName);

  async function readStoredCookies(): Promise<StoredCookies> {
    try {
      return JSON.parse(await readFile(storagePath, "utf8")) as StoredCookies;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  async function writeStoredCookies(cookies: StoredCookies): Promise<void> {
    await mkdir(userDataPath, { recursive: true });
    const temporaryPath = path.join(userDataPath, `.${cookieFileName}.${randomUUID()}.tmp`);

    try {
      await writeFile(temporaryPath, JSON.stringify(cookies), { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, storagePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  return {
    async set(source, value) {
      const cookies = await readStoredCookies();
      if (value.length === 0) {
        delete cookies[source];
      } else {
        cookies[source] = safeStorage.encryptString(value).toString("base64");
      }
      await writeStoredCookies(cookies);
    },

    async get(source) {
      const storedValue = (await readStoredCookies())[source];
      return storedValue === undefined ? undefined : safeStorage.decryptString(Buffer.from(storedValue, "base64"));
    },

    async redacted(source) {
      return (await readStoredCookies())[source] === undefined ? "unconfigured" : "configured";
    },

    filePath() {
      return storagePath;
    }
  };
}
