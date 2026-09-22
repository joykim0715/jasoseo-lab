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
  /** 같은 실제 경험을 가리키는 episode끼리 동일 */
  canonicalGroupId?: string;
  source: "portfolio" | "notion";
};

export type EssayReferenceType = "baseline" | "final" | "reference" | "draft";

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
  /** 없으면 일반 reference. Notion 속성 없어도 앱은 동작 */
  referenceType?: EssayReferenceType;
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
    /** snapshot experience.id — 같은 실제 경험이면 설정 */
    experienceId?: string;
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
  /** STAR(상황-과제-행동-결과) 중심으로 구성 */
  structureStar: boolean;
  /** 두괄식: 문단·답변 앞에 핵심 포인트 */
  leadWithPoint: boolean;
  /** 문제→행동→결과 인과·논리 연결 강화 */
  causalLogic: boolean;
  /** JD 요구역량과 경험을 명시적으로 연결 */
  jdLink: boolean;
  /** 문장·문단 전환을 자연스럽게, 비약·군더더기 최소화 */
  smoothFlow: boolean;
  /** 동일 경험·표현·키워드 반복 최소화 */
  noRepetition: boolean;
  /** 블라인드 채용: 학교명 비노출·일반화 */
  blindSchool: boolean;
  /** 블라인드 채용: 이전 근무 기업명 비노출·일반화 */
  blindCompany: boolean;
  /** 블라인드 채용: 사내/특정 프로젝트명 비노출·일반화 */
  blindProject: boolean;
  /** 블라인드 채용: 학점·석차 등 학력 상세 비노출 */
  blindGpa: boolean;
  /** 블라인드 채용: 출신지역·가족관계 비노출 */
  blindPersonal: boolean;
  /** 블라인드 채용: 나이·성별 암시 표현 금지 */
  blindDemographics: boolean;
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

export type EssayValidationIssue = {
  code: string;
  severity: "error" | "warning";
  message: string;
};

export type EssayValidationResult = {
  valid: boolean;
  issues: EssayValidationIssue[];
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
  usedFactIds?: string[];
  retrievedEssayIds?: string[];
  revised?: boolean;
  validation?: EssayValidationResult;
  failed?: boolean;
  retryable?: boolean;
};

export type GenerateResult = {
  /** 기본 생성에서는 비움. 구세션·optional review 호환 */
  personas?: HiringPersona[];
  answers: EssayAnswer[];
  matchingNotes: string[];
  personaFeedback?: string;
  /** engine 2.0 — 구세션에는 없음 */
  plan?: EssayPlan;
};

export type FactItem = {
  id: string;
  label: string;
  value: string;
  category:
    | "metric"
    | "role"
    | "period"
    | "education"
    | "certification"
    | "skill"
    | "other";
  episodeId?: string;
  source: string;
  status: "locked" | "reference" | "disabled";
  tags?: string[];
  preferredQuestionTypes?: string[];
};

export type FactMaster = {
  version: number;
  facts: FactItem[];
};

export type QuestionIntent = {
  questionId: string;
  questionType: string;
  goals: string[];
  evidencePriorities: string[];
  jdSignals: string[];
  avoid: string[];
};

export type EpisodeCandidate = {
  episodeId: string;
  score: number;
  reasons: string[];
};

export type EssayPlanItem = {
  questionId: string;
  intent: QuestionIntent;
  primaryEpisodeId?: string;
  secondaryEpisodeId?: string;
  allowedFactIds: string[];
  targetJdSignals: string[];
  thesis: string;
  notes: string[];
};

export type EssayPlan = {
  items: EssayPlanItem[];
};
