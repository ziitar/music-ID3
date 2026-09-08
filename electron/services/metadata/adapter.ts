import type { CoverArt, MetadataCandidate } from "../../../shared/types";

export type MetadataAdapter = {
  search(query: string): Promise<MetadataCandidate[]>;
  getDetails(id: string): Promise<MetadataCandidate>;
  getCover(candidate: MetadataCandidate): Promise<CoverArt | undefined>;
  testConnection?(): Promise<void>;
};

export type LocalMatchContext = {
  title?: string;
  artist?: string;
  trackCount?: number;
  durationMs?: number;
  trackDurationsMs?: number[];
  discId?: string;
  toc?: string;
};

export type MatchScore = {
  score: number;
  confidence: MetadataCandidate["confidence"];
  evidence: string[];
};

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function similarity(left: string | undefined, right: string | undefined): number {
  if (!left || !right) return 0;
  const a = normalized(left);
  const b = normalized(right);
  if (a === b) return 1;
  if (!a || !b) return 0;
  const leftTokens = new Set(a.split(" "));
  const rightTokens = new Set(b.split(" "));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return (2 * intersection) / (leftTokens.size + rightTokens.size);
}

function closeDuration(left: number | undefined, right: number | undefined): boolean {
  if (left === undefined || right === undefined || left <= 0 || right <= 0) return false;
  return Math.abs(left - right) <= Math.max(2000, Math.max(left, right) * 0.01);
}

export function scoreCandidate(local: LocalMatchContext, candidate: MetadataCandidate): MatchScore {
  let score = 0;
  const evidence: string[] = [];
  let structuralSignals = 0;

  const titleScore = similarity(local.title, candidate.title || candidate.album);
  if (titleScore > 0.7) {
    score += Math.round(titleScore * 20);
    evidence.push("Title matched");
  }
  const artistScore = similarity(local.artist, candidate.artist);
  if (artistScore > 0.7) {
    score += Math.round(artistScore * 15);
    evidence.push("Artist matched");
  }
  if (local.trackCount !== undefined && candidate.trackCount !== undefined && local.trackCount === candidate.trackCount) {
    score += 15;
    structuralSignals += 1;
    evidence.push("Track count matched");
  }
  if (local.durationMs !== undefined && candidate.totalDurationMs !== undefined) {
    if (closeDuration(local.durationMs, candidate.totalDurationMs)) {
      score += 40;
      structuralSignals += 1;
      evidence.push("Total duration matched");
    } else {
      score -= 25;
      evidence.push("Total duration differed");
    }
  }
  const candidateDurations = candidate.tracks?.map((track) => track.durationMs);
  if (
    local.trackDurationsMs?.length &&
    candidateDurations?.length === local.trackDurationsMs.length &&
    candidateDurations.every((duration, index) => closeDuration(local.trackDurationsMs?.[index], duration))
  ) {
    score += 10;
    structuralSignals += 1;
    evidence.push("Per-track durations matched");
  }
  if (local.discId && (candidate.discId === local.discId || candidate.discIds?.includes(local.discId))) {
    score += 20;
    structuralSignals += 2;
    evidence.push("Disc ID matched");
  }
  if (local.toc && candidate.toc === local.toc) {
    score += 10;
    structuralSignals += 2;
    evidence.push("TOC matched");
  }
  if (candidate.ctdb?.status === "match") {
    score += 10;
    structuralSignals += 1;
    evidence.push("CTDB verified the pressing");
  }

  score = Math.max(0, Math.min(100, score));
  const confidence = structuralSignals >= 3 && score >= 80
    ? "high"
    : structuralSignals >= 1 && score >= 50
      ? "medium"
      : "low";
  return { score, confidence, evidence };
}
