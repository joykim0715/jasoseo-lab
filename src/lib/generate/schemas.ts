import { z } from "zod";

export const questionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string(),
  charLimit: z.number().int().min(0),
  countSpaces: z.boolean(),
});

export const setupSchema = z.object({
  freeForm: z.boolean().optional().default(false),
  questions: z.array(questionSchema).min(1),
  constraints: z.object({
    freeText: z.string(),
    structureStar: z.boolean(),
    leadWithPoint: z.boolean(),
    causalLogic: z.boolean(),
    jdLink: z.boolean(),
    smoothFlow: z.boolean(),
    noRepetition: z.boolean(),
    blindSchool: z.boolean(),
    blindCompany: z.boolean(),
    blindProject: z.boolean(),
    blindGpa: z.boolean(),
    blindPersonal: z.boolean(),
    blindDemographics: z.boolean(),
  }),
});

export const jobSchema = z.object({
  company: z.string(),
  role: z.string(),
  requirements: z.array(z.string()),
  preferred: z.array(z.string()),
  responsibilities: z.array(z.string()),
  keywords: z.array(z.string()),
  cultureSignals: z.array(z.string()),
  essayQuestionsHint: z.array(z.string()).optional().default([]),
  rawText: z.string(),
  warnings: z.array(z.string()),
});

const hiringPersonaSchema = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string(),
  focus: z.string(),
  likes: z.array(z.string()),
  redFlags: z.array(z.string()),
  weight: z.number(),
});

const essayAnswerSchema = z.object({
  questionId: z.string(),
  title: z.string(),
  prompt: z.string(),
  body: z.string(),
  charCount: z.number(),
  charLimit: z.number(),
  countSpaces: z.boolean(),
  withinLimit: z.boolean(),
  constraintNotes: z.array(z.string()),
  usedEpisodeIds: z.array(z.string()),
  usedFactIds: z.array(z.string()).optional(),
  retrievedEssayIds: z.array(z.string()).optional(),
  revised: z.boolean().optional(),
  validation: z
    .object({
      valid: z.boolean(),
      issues: z.array(
        z.object({
          code: z.string(),
          severity: z.enum(["error", "warning"]),
          message: z.string(),
        }),
      ),
    })
    .optional(),
});

export const questionIntentSchema = z.object({
  questionId: z.string().min(1),
  questionType: z.string().min(1),
  goals: z.array(z.string()),
  evidencePriorities: z.array(z.string()),
  jdSignals: z.array(z.string()),
  avoid: z.array(z.string()),
});

export const essayPlanItemSchema = z.object({
  questionId: z.string().min(1),
  intent: questionIntentSchema,
  primaryEpisodeId: z.string().min(1).optional(),
  secondaryEpisodeId: z.string().min(1).optional(),
  allowedFactIds: z.array(z.string()),
  targetJdSignals: z.array(z.string()),
  thesis: z.string(),
  notes: z.array(z.string()),
});

export const essayPlanSchema = z.object({
  items: z.array(essayPlanItemSchema),
});

export const previousResultSchema = z.object({
  personas: z.array(hiringPersonaSchema).optional().default([]),
  answers: z.array(essayAnswerSchema),
  matchingNotes: z.array(z.string()),
  personaFeedback: z.string().optional().default(""),
  plan: essayPlanSchema.optional(),
});
