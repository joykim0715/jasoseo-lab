export type ExperienceEpisode = {
  id: string;
  title: string;
  organization?: string;
  role?: string;
  period?: string;
  situation?: string;
  task?: string;
  action?: string;
  result?: string;
  metrics?: string;
  highlights: string[];
  tags: string[];
  skills: string[];
  portfolioWorkId?: string;
  preferredQuestions: string[];
  source: "portfolio" | "notion";
};

export type EssayArchiveItem = {
  id: string;
  name: string;
  company?: string;
  role?: string;
  question: string;
  answer: string;
  charCount?: number;
  tone?: string;
  rating?: string;
};

export type CandidateProfile = {
  name: string;
  tagline: string;
  bio: string;
  about: string;
  portfolioUrl: string;
  education: { school: string; period: string; major: string }[];
  skills: { category: string; tools: string; details: string[] }[];
  experiences: ExperienceEpisode[];
  works: {
    id: string;
    title: string;
    category: string;
    description: string;
    role?: string;
    metrics: string[];
    tags: string[];
  }[];
  certifications: {
    name: string;
    fullName: string;
    issuer: string;
    date: string;
    description: string;
  }[];
  values: string[];
  essayArchive: EssayArchiveItem[];
};

export type JobPosting = {
  company: string;
  role: string;
  requirements: string[];
  preferred: string[];
  responsibilities: string[];
  keywords: string[];
  cultureSignals: string[];
  essayQuestionsHint: string[];
  rawText: string;
  warnings: string[];
};

export type EssayQuestion = {
  id: string;
  title: string;
  prompt: string;
  charLimit: number;
  countSpaces: boolean;
};

export type WritingConstraints = {
  freeText: string;
  requireNumbers: boolean;
  mentionCompany: boolean;
  formalTone: boolean;
  noFabrication: boolean;
};

export type SetupConfig = {
  /** true면 국내 기업 표준 자소서 항목으로 생성 (수동 문항 무시) */
  freeForm: boolean;
  questions: EssayQuestion[];
  constraints: WritingConstraints;
};

export type HiringPersona = {
  id: string;
  name: string;
  title: string;
  focus: string;
  likes: string[];
  redFlags: string[];
  weight: number;
};

export type EssayAnswer = {
  questionId: string;
  title: string;
  prompt: string;
  body: string;
  charCount: number;
  charLimit: number;
  countSpaces: boolean;
  withinLimit: boolean;
  constraintNotes: string[];
  usedEpisodeIds: string[];
};

export type GenerateResult = {
  personas: HiringPersona[];
  answers: EssayAnswer[];
  matchingNotes: string[];
  personaFeedback: string;
};
