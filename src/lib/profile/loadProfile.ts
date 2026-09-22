import { portfolioUrl } from "../site";
import { readFile } from "fs/promises";
import path from "path";
import type { CandidateProfile, ExperienceEpisode } from "../types";
import { loadNotionEssays, loadNotionExperiences } from "../notion/loadExperiences";
import { notionConfigured } from "../notion/client";

export type Snapshot = {
  name: string;
  tagline: string;
  bio: string;
  about: string;
  portfolioUrl: string;
  education: CandidateProfile["education"];
  skills: CandidateProfile["skills"];
  experiences: {
    id: string;
    organization: string;
    role: string;
    period: string;
    employmentType: string;
    highlights: string[];
    tags: string[];
  }[];
  works: CandidateProfile["works"];
  certifications: CandidateProfile["certifications"];
  values: string[];
};

async function readSnapshot(): Promise<Snapshot> {
  const file = path.join(process.cwd(), "data", "profile.snapshot.json");
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw) as Snapshot;
}

/** 기준정보 경험 카드 ↔ 문항 유형. Notion preferredQuestions가 있으면 그쪽이 이김. */
const SNAPSHOT_PREFERRED: Record<string, string[]> = {
  "homecare-researcher": ["직무역량", "경험", "competency", "지원동기"],
  "work-01": ["직무역량", "경험", "competency"],
  "work-02": ["지원동기", "직무역량", "motivation", "competency"],
  "work-03": ["성격", "장단점", "personality", "협업", "collaboration"],
  "work-04": ["지원동기", "직무역량", "motivation", "competency"],
  "work-05": ["직무역량", "성장과정", "competency", "growth"],
  floorball: [
    "성장과정",
    "growth",
    "협업",
    "collaboration",
    "팀워크",
  ],
};

export function snapshotToEpisodes(snap: Snapshot): ExperienceEpisode[] {
  const fromExp = snap.experiences.map((e) => ({
    id: e.id,
    title: `${e.organization} · ${e.role}`,
    organization: e.organization,
    role: e.role,
    period: e.period,
    highlights: e.highlights,
    tags: e.tags,
    skills: [],
    preferredQuestions: SNAPSHOT_PREFERRED[e.id] ?? [],
    canonicalGroupId: e.id,
    source: "portfolio" as const,
  }));

  const fromWorks = snap.works.map((w) => ({
    id: `work-${w.id}`,
    title: w.title,
    role: w.role,
    highlights: [w.description, ...w.metrics],
    tags: w.tags,
    skills: w.tags,
    portfolioWorkId: w.id,
    preferredQuestions: SNAPSHOT_PREFERRED[`work-${w.id}`] ?? [],
    metrics: w.metrics.join(", "),
    canonicalGroupId: w.experienceId ?? `work-${w.id}`,
    source: "portfolio" as const,
  }));

  return [...fromExp, ...fromWorks];
}

export async function loadCandidateProfile(): Promise<{
  profile: CandidateProfile;
  notionConnected: boolean;
}> {
  const snap = await readSnapshot();
  const portfolioEpisodes = snapshotToEpisodes(snap);
  const notionEpisodes = await loadNotionExperiences();
  const essayArchive = await loadNotionEssays();

  const seen = new Set(notionEpisodes.map((e) => e.title.toLowerCase()));
  const mergedExperiences = [
    ...notionEpisodes,
    ...portfolioEpisodes.filter((e) => !seen.has(e.title.toLowerCase())),
  ];

  const profile: CandidateProfile = {
    name: snap.name,
    tagline: snap.tagline,
    bio: snap.bio,
    about: snap.about,
    portfolioUrl: process.env.NEXT_PUBLIC_PORTFOLIO_URL ?? portfolioUrl ?? snap.portfolioUrl,
    education: snap.education,
    skills: snap.skills,
    experiences: mergedExperiences,
    works: snap.works,
    certifications: snap.certifications,
    values: snap.values,
    essayArchive,
  };

  return {
    profile,
    notionConnected: notionConfigured(),
  };
}
