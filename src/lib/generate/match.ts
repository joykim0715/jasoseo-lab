import type { CandidateProfile, ExperienceEpisode, JobPosting } from "../types";

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^0-9a-zA-Z가-힣+#.]/)
      .filter((t) => t.length >= 2),
  );
}

export function scoreEpisode(
  episode: ExperienceEpisode,
  job: JobPosting,
): number {
  const jobTokens = tokenize(
    [
      job.role,
      ...job.requirements,
      ...job.preferred,
      ...job.responsibilities,
      ...job.keywords,
    ].join(" "),
  );
  const epTokens = tokenize(
    [
      episode.title,
      episode.organization ?? "",
      episode.role ?? "",
      ...episode.highlights,
      ...episode.tags,
      ...episode.skills,
      episode.metrics ?? "",
      episode.situation ?? "",
      episode.action ?? "",
      episode.result ?? "",
    ].join(" "),
  );

  let overlap = 0;
  for (const t of epTokens) {
    if (jobTokens.has(t)) overlap += 1;
  }

  const densityBonus = Math.min(episode.highlights.join("").length / 200, 3);
  const metricBonus = episode.metrics || /\d/.test(episode.highlights.join(" ")) ? 2 : 0;
  return overlap + densityBonus + metricBonus;
}

export function selectEpisodes(
  profile: CandidateProfile,
  job: JobPosting,
  limit = 6,
): { episodes: ExperienceEpisode[]; notes: string[] } {
  const ranked = profile.experiences
    .map((e) => ({ e, score: scoreEpisode(e, job) }))
    .sort((a, b) => b.score - a.score);

  const top = ranked.slice(0, limit).filter((r) => r.score > 0);
  const chosen = (top.length ? top : ranked.slice(0, Math.min(4, ranked.length))).map(
    (r) => r.e,
  );

  const notes = chosen.map(
    (e) =>
      `· ${e.title} (매칭 점수 ${ranked.find((r) => r.e.id === e.id)?.score.toFixed(1)})`,
  );

  return { episodes: chosen, notes };
}
