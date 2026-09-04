import type { CoverArt, MetadataCandidate } from "../../../shared/types";
import type { MetadataAdapter } from "./adapter";
import type { HttpClient } from "./http-client";

export type CtdbValidationResult =
  | { status: "match"; confidence?: number; evidence: string[] }
  | { status: "no-match"; evidence: string[] }
  | { status: "unavailable"; error: string; evidence: string[] };

export type CtdbAdapter = MetadataAdapter & {
  validate(toc: string, signal?: AbortSignal): Promise<CtdbValidationResult>;
};

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
      const url = `https://db.cue.tools/lookup2.php?version=3&ctdb=1&metadata=extensive&toc=${encodeURIComponent(toc)}`;
      try {
        const document = await options.http.getBytes("ctdb", url, { signal, cacheTtlMs: 5 * 60 * 1000 });
        const xml = new TextDecoder().decode(document.data);
        if (/\bnentries=["']0["']/i.test(xml) || /<error[^>]*>.*not found/is.test(xml)) {
          return { status: "no-match", evidence: ["CTDB returned no matching pressing"] };
        }
        const confidence = Number.parseInt(xml.match(/\bconfidence=["'](\d+)["']/i)?.[1] ?? "", 10);
        if (/<entry\b/i.test(xml) || /\bnentries=["'][1-9]\d*["']/i.test(xml)) {
          return {
            status: "match",
            ...(Number.isFinite(confidence) ? { confidence } : {}),
            evidence: ["CTDB verified the pressing"]
          };
        }
        return { status: "no-match", evidence: ["CTDB returned no matching pressing"] };
      } catch {
        return { status: "unavailable", error: "CTDB validation is unavailable", evidence: [] };
      }
    }
  };
}
