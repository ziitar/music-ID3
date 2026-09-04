import type { CoverArt, MetadataCandidate } from "../../../shared/types";
import type { MetadataAdapter } from "./adapter";
import { HttpRequestError, type HttpClient } from "./http-client";

export type CtdbValidationResult =
  | { status: "match"; confidence?: number; evidence: string[] }
  | { status: "no-match"; evidence: string[] }
  | { status: "unavailable"; error: string; evidence: string[] };

export type CtdbAdapter = MetadataAdapter & {
  validate(toc: string, signal?: AbortSignal): Promise<CtdbValidationResult>;
};

export function toCtdbToc(disc: { offsets: readonly number[]; sectors: number }): string {
  if (!disc.offsets.length || !disc.offsets.every(Number.isInteger) || !Number.isInteger(disc.sectors)) {
    throw new TypeError("CTDB conversion requires integer MusicBrainz offsets and lead-out");
  }
  const firstOffset = disc.offsets[0];
  if (firstOffset < 0 || disc.sectors <= firstOffset) {
    throw new RangeError("MusicBrainz lead-out must follow the first track offset");
  }
  for (let index = 1; index < disc.offsets.length; index += 1) {
    if (disc.offsets[index] <= disc.offsets[index - 1] || disc.offsets[index] >= disc.sectors) {
      throw new RangeError("MusicBrainz track offsets must increase before the lead-out");
    }
  }
  return [...disc.offsets.map((offset) => offset - firstOffset), disc.sectors - firstOffset].join(":");
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

export function createCtdbAdapter(options: { http: HttpClient }): CtdbAdapter {
  return {
    async search() {
      return [];
    },

    async getDetails(id) {
      return { id, source: "ctdb", title: "CTDB verification", confidence: "low" };
    },

    async getCover(_candidate: MetadataCandidate): Promise<CoverArt | undefined> {
      return undefined;
    },

    async validate(toc, signal) {
      if (!/^0(?::\d+)+$/.test(toc)) throw new TypeError("CTDB TOC must use relative colon-delimited offsets");
      const url = `https://db.cuetools.net/lookup2.php?version=3&ctdb=1&fuzzy=0&metadata=extensive&toc=${encodeURIComponent(toc)}`;
      try {
        const document = await options.http.getBytes("ctdb", url, {
          signal,
          cacheTtlMs: 5 * 60 * 1000,
          headers: { "User-Agent": "MusicID3Desktop/1.0 (https://github.com/uziit/music-ID3)" }
        });
        const xml = new TextDecoder().decode(document.data);
        const validDocument = /^\s*(?:<\?xml\b[^>]*>\s*)?<ctdb\b[^>]*(?:\/\s*>|>[\s\S]*<\/ctdb\s*>)\s*$/i.test(xml);
        if (validDocument && /<ctdb\b[^>]*\bnentries=["']0["']/i.test(xml)) {
          return { status: "no-match", evidence: ["CTDB returned no matching pressing"] };
        }
        const confidence = Number.parseInt(xml.match(/\bconfidence=["'](\d+)["']/i)?.[1] ?? "", 10);
        if (validDocument && (/<entry\b/i.test(xml) || /<ctdb\b[^>]*\bnentries=["'][1-9]\d*["']/i.test(xml))) {
          return {
            status: "match",
            ...(Number.isFinite(confidence) ? { confidence } : {}),
            evidence: ["CTDB verified the pressing"]
          };
        }
        return { status: "unavailable", error: "CTDB returned an invalid response", evidence: [] };
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (error instanceof HttpRequestError && error.status === 404) {
          return { status: "no-match", evidence: ["CTDB returned no matching pressing"] };
        }
        if (error instanceof HttpRequestError && (error.status === undefined || error.status >= 500)) {
          return { status: "unavailable", error: "CTDB validation is unavailable", evidence: [] };
        }
        throw error;
      }
    }
  };
}
