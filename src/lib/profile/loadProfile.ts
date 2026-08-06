import { portfolioUrl } from "../site";
import { readFile } from "fs/promises";
import path from "path";
import type { CandidateProfile, ExperienceEpisode } from "../types";
import { loadNotionEssays, loadNotionExperiences } from "../notion/loadExperiences";
import { notionConfigured } from "../notion/client";

type Snapshot = {
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

function snapshotToEpisodes(snap: Snapshot): ExperienceEpisode[] {
  const fromExp = snap.experiences.map((e) => ({
    id: e.id,
    title: `${e.organization} · ${e.role}`,
    organization: e.organization,
    role: e.role,
    period: e.period,
    highlights: e.highlights,
    tags: e.tags,
    skills: [],
    preferredQuestions: [],
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
    preferredQuestions: [],
    metrics: w.metrics.join(", "),
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
