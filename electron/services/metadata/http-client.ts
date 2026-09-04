import type { MetadataSource } from "../../../shared/types";

export type HttpTransportRequest = {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string | Uint8Array;
  signal: AbortSignal;
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
    const headers: Record<string, string> = {};
    result.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    return { status: result.status, headers, body: new Uint8Array(await result.arrayBuffer()) };
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

export function createHttpClient(options: {
  transport: HttpTransport;
  policies?: Partial<Record<MetadataSource, ProviderPolicy>>;
  defaultTimeoutMs?: number;
  diagnostics?: (entry: HttpDiagnostic) => void;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}): HttpClient {
  const policies = { ...defaultPolicies, ...options.policies };
  const cache = new Map<string, { expiresAt: number; response: HttpTransportResponse }>();
  const lastRequestAt = new Map<MetadataSource, number>();
  const rateQueues = new Map<MetadataSource, Promise<void>>();
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 10000;

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

  async function request(provider: MetadataSource, url: string, requestOptions: HttpRequestOptions = {}): Promise<HttpTransportResponse> {
    const method = requestOptions.method ?? "GET";
    const cacheKey = `${provider}:${method}:${url}:${typeof requestOptions.body === "string" ? requestOptions.body : ""}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now()) return cached.response;

    const policy = policies[provider];
    for (let attempt = 0; attempt <= policy.retries; attempt += 1) {
      if (requestOptions.signal?.aborted) throw abortError();
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
        const dynamicHeaders = requestOptions.getHeaders ? await requestOptions.getHeaders() : {};
        const requestUrl = sanitizedUrl(url);
        options.diagnostics?.({ provider, phase: "request", url: requestUrl, attempt: attempt + 1 });
        const response = await options.transport({
          url,
          method,
          headers: { ...requestOptions.headers, ...dynamicHeaders },
          body: requestOptions.body,
          signal: controller.signal
        });
        if (response.status < 200 || response.status >= 300) {
          throw new HttpRequestError(`Provider request failed with HTTP ${response.status}`, response.status);
        }
        options.diagnostics?.({ provider, phase: "success", url: requestUrl, attempt: attempt + 1, status: response.status });
        if (requestOptions.cacheTtlMs && requestOptions.cacheTtlMs > 0) {
          cache.set(cacheKey, { expiresAt: now() + requestOptions.cacheTtlMs, response });
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
