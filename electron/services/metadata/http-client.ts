import { createHash } from "node:crypto";
import type { MetadataSource } from "../../../shared/types";

export type HttpTransportRequest = {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string | Uint8Array;
  signal: AbortSignal;
  maxResponseBytes: number;
};

export type HttpTransportResponse = {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
};

export type HttpTransport = (request: HttpTransportRequest) => Promise<HttpTransportResponse>;

export type ProviderPolicy = {
  minIntervalMs: number;
  retries: number;
};

export type HttpDiagnostic = {
  provider: MetadataSource;
  phase: "request" | "retry" | "success" | "failure";
  url: string;
  attempt: number;
  status?: number;
  error?: string;
};

export type HttpRequestOptions = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  getHeaders?: () => Promise<Record<string, string>>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
  timeoutMs?: number;
  cacheTtlMs?: number;
  cacheKey?: string;
  maxResponseBytes?: number;
};

export type HttpClient = {
  getJson<T = unknown>(provider: MetadataSource, url: string, options?: HttpRequestOptions): Promise<T>;
  postJson<T = unknown>(provider: MetadataSource, url: string, options?: HttpRequestOptions): Promise<T>;
  getBytes(provider: MetadataSource, url: string, options?: HttpRequestOptions): Promise<{ data: Uint8Array; mimeType: string }>;
  clearCache(): void;
};

export class HttpRequestError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "HttpRequestError";
    this.status = status;
  }
}

export function createElectronTransport(electronNet: {
  fetch(input: string | Request, init?: RequestInit & { bypassCustomProtocolHandlers?: boolean }): Promise<Response>;
}): HttpTransport {
  return async (request) => {
    const body: BodyInit | undefined = typeof request.body === "string"
      ? request.body
      : request.body
        ? Uint8Array.from(request.body).buffer
        : undefined;
    const result = await electronNet.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body,
      signal: request.signal
    });
    const declaredLength = Number(result.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > request.maxResponseBytes) {
      throw new HttpRequestError("Provider response exceeded size limit");
    }
    const headers: Record<string, string> = {};
    result.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    const bodyBytes = new Uint8Array(await result.arrayBuffer());
    if (bodyBytes.byteLength > request.maxResponseBytes) {
      throw new HttpRequestError("Provider response exceeded size limit");
    }
    return { status: result.status, headers, body: bodyBytes };
  };
}

const defaultPolicies: Record<MetadataSource, ProviderPolicy> = {
  musicbrainz: { minIntervalMs: 1000, retries: 1 },
  ctdb: { minIntervalMs: 500, retries: 1 },
  netease: { minIntervalMs: 250, retries: 1 },
  qq: { minIntervalMs: 250, retries: 1 }
};

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

function sanitizedUrl(value: string): string {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) {
    if (/cookie|token|auth|key|session|csrf/i.test(key)) url.searchParams.set(key, "[REDACTED]");
  }
  return url.toString();
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

function asText(body: string | Uint8Array): string {
  return typeof body === "string" ? body : new TextDecoder().decode(body);
}

function responseBytes(body: string | Uint8Array): number {
  return typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const match = Object.entries(headers).find(([key]) => key.toLocaleLowerCase("en-US") === name);
  return match?.[1];
}

function authDigest(headers: Record<string, string>): string {
  const authHeaders = Object.entries(headers)
    .filter(([name]) => /^(authorization|cookie|proxy-authorization|x-music-u)$/i.test(name))
    .map(([name, value]) => [name.toLocaleLowerCase("en-US"), value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(authHeaders)).digest("hex");
}

export function createHttpClient(options: {
  transport: HttpTransport;
  policies?: Partial<Record<MetadataSource, ProviderPolicy>>;
  defaultTimeoutMs?: number;
  diagnostics?: (entry: HttpDiagnostic) => void;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  defaultMaxResponseBytes?: number;
  maxCacheEntries?: number;
}): HttpClient {
  const policies = { ...defaultPolicies, ...options.policies };
  const cache = new Map<string, { expiresAt: number; response: HttpTransportResponse }>();
  const lastRequestAt = new Map<MetadataSource, number>();
  const rateQueues = new Map<MetadataSource, Promise<void>>();
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 10000;
  const defaultMaxResponseBytes = options.defaultMaxResponseBytes ?? 5 * 1024 * 1024;
  const maxCacheEntries = options.maxCacheEntries ?? 128;

  function purgeExpiredCacheEntries(): void {
    const currentTime = now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= currentTime) cache.delete(key);
    }
  }

  function readCache(key: string): HttpTransportResponse | undefined {
    purgeExpiredCacheEntries();
    const entry = cache.get(key);
    if (!entry) return undefined;
    cache.delete(key);
    cache.set(key, entry);
    return entry.response;
  }

  function writeCache(key: string, expiresAt: number, response: HttpTransportResponse): void {
    if (maxCacheEntries <= 0) return;
    purgeExpiredCacheEntries();
    cache.delete(key);
    while (cache.size >= maxCacheEntries) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }
    cache.set(key, { expiresAt, response });
  }

  async function acquireRateLimit(provider: MetadataSource, signal?: AbortSignal): Promise<void> {
    const previousTurn = rateQueues.get(provider) ?? Promise.resolve();
    const turn = previousTurn.catch(() => undefined).then(async () => {
      if (signal?.aborted) throw abortError();
      const previousRequest = lastRequestAt.get(provider);
      if (previousRequest !== undefined) {
        const waitFor = Math.max(0, previousRequest + policies[provider].minIntervalMs - now());
        if (waitFor > 0) await sleep(waitFor, signal);
      }
      lastRequestAt.set(provider, now());
    });
    rateQueues.set(provider, turn);
    await turn;
  }

  async function resolveHeaders(requestOptions: HttpRequestOptions): Promise<Record<string, string>> {
    try {
      const dynamicHeaders = requestOptions.getHeaders ? await requestOptions.getHeaders() : {};
      if (requestOptions.signal?.aborted) throw abortError();
      return { ...requestOptions.headers, ...dynamicHeaders };
    } catch (error) {
      if (requestOptions.signal?.aborted) throw abortError();
      throw error instanceof HttpRequestError ? error : new HttpRequestError("Provider request headers are unavailable");
    }
  }

  async function request(provider: MetadataSource, url: string, requestOptions: HttpRequestOptions = {}): Promise<HttpTransportResponse> {
    const method = requestOptions.method ?? "GET";
    const policy = policies[provider];
    for (let attempt = 0; attempt <= policy.retries; attempt += 1) {
      if (requestOptions.signal?.aborted) throw abortError();
      const headers = await resolveHeaders(requestOptions);
      const cacheBase = requestOptions.cacheKey ?? `${provider}:${method}:${url}:${typeof requestOptions.body === "string" ? requestOptions.body : ""}`;
      const cacheKey = `${cacheBase}:${authDigest(headers)}`;
      if (attempt === 0 && requestOptions.cacheTtlMs && requestOptions.cacheTtlMs > 0) {
        const cached = readCache(cacheKey);
        if (cached) return cached;
      }
      await acquireRateLimit(provider, requestOptions.signal);

      const controller = new AbortController();
      let timedOut = false;
      const onAbort = () => controller.abort(abortError());
      requestOptions.signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("timeout"));
      }, requestOptions.timeoutMs ?? defaultTimeoutMs);

      try {
        const requestUrl = sanitizedUrl(url);
        const maxResponseBytes = requestOptions.maxResponseBytes ?? defaultMaxResponseBytes;
        options.diagnostics?.({ provider, phase: "request", url: requestUrl, attempt: attempt + 1 });
        const response = await options.transport({
          url,
          method,
          headers,
          body: requestOptions.body,
          signal: controller.signal,
          maxResponseBytes
        });
        if (response.status < 200 || response.status >= 300) {
          throw new HttpRequestError(`Provider request failed with HTTP ${response.status}`, response.status);
        }
        const declaredLength = Number(headerValue(response.headers, "content-length"));
        if (
          (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) ||
          responseBytes(response.body) > maxResponseBytes
        ) {
          throw new HttpRequestError("Provider response exceeded size limit");
        }
        options.diagnostics?.({ provider, phase: "success", url: requestUrl, attempt: attempt + 1, status: response.status });
        if (requestOptions.cacheTtlMs && requestOptions.cacheTtlMs > 0) {
          writeCache(cacheKey, now() + requestOptions.cacheTtlMs, response);
        }
        return response;
      } catch (error) {
        if (requestOptions.signal?.aborted) throw abortError();
        const safeUrl = sanitizedUrl(url);
        if (timedOut) {
          options.diagnostics?.({ provider, phase: "failure", url: safeUrl, attempt: attempt + 1, error: "Request timed out" });
          throw new HttpRequestError("Provider request timed out");
        }
        const status = error instanceof HttpRequestError ? error.status : undefined;
        const transient = error instanceof TypeError || (status !== undefined && isTransientStatus(status));
        if (transient && attempt < policy.retries) {
          options.diagnostics?.({ provider, phase: "retry", url: safeUrl, attempt: attempt + 1, status, error: "Transient provider failure" });
          continue;
        }
        options.diagnostics?.({ provider, phase: "failure", url: safeUrl, attempt: attempt + 1, status, error: "Provider request failed" });
        throw error instanceof HttpRequestError ? error : new HttpRequestError("Provider network request failed");
      } finally {
        clearTimeout(timeout);
        requestOptions.signal?.removeEventListener("abort", onAbort);
      }
    }
    throw new HttpRequestError("Provider request failed");
  }

  async function json<T>(provider: MetadataSource, url: string, requestOptions: HttpRequestOptions): Promise<T> {
    const result = await request(provider, url, requestOptions);
    try {
      return JSON.parse(asText(result.body)) as T;
    } catch {
      throw new HttpRequestError("Provider returned invalid JSON", result.status);
    }
  }

  return {
    getJson: (provider, url, requestOptions = {}) => json(provider, url, { ...requestOptions, method: "GET" }),
    postJson: (provider, url, requestOptions = {}) => json(provider, url, { ...requestOptions, method: "POST" }),
    async getBytes(provider, url, requestOptions = {}) {
      const result = await request(provider, url, { ...requestOptions, method: "GET" });
      return {
        data: typeof result.body === "string" ? new TextEncoder().encode(result.body) : result.body,
        mimeType: result.headers["content-type"]?.split(";", 1)[0] ?? "application/octet-stream"
      };
    },
    clearCache() {
      cache.clear();
    }
  };
}
