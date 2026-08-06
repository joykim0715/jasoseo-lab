import type {
  CandidateProfile,
  EssayArchiveItem,
  ExperienceEpisode,
  JobPosting,
  SetupConfig,
  GenerateResult,
} from "./types";

const KEYS = {
  job: "jasoseo:job",
  setup: "jasoseo:setup",
  result: "jasoseo:result",
  profileMeta: "jasoseo:profileMeta",
} as const;

function read<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(key, JSON.stringify(value));
}

export function saveJob(job: JobPosting) {
  write(KEYS.job, job);
}

export function loadJob(): JobPosting | null {
  return read<JobPosting>(KEYS.job);
}

export function saveSetup(setup: SetupConfig) {
  write(KEYS.setup, setup);
}

export function loadSetup(): SetupConfig | null {
  return read<SetupConfig>(KEYS.setup);
}

export function saveResult(result: GenerateResult) {
  write(KEYS.result, result);
}

export function loadResult(): GenerateResult | null {
  return read<GenerateResult>(KEYS.result);
}

export function saveProfileMeta(meta: {
  experienceCount: number;
  essayCount: number;
  notionConnected: boolean;
}) {
  write(KEYS.profileMeta, meta);
}

export type { CandidateProfile, EssayArchiveItem, ExperienceEpisode };
