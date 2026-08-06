import { claudeJson } from "../claude";
import type { HiringPersona, JobPosting } from "../types";

export async function buildPersonas(job: JobPosting): Promise<HiringPersona[]> {
  const parsed = await claudeJson<{
    personas: {
      name: string;
      title: string;
      focus: string;
      likes: string[];
      redFlags: string[];
      weight: number;
    }[];
  }>({
    system: `You design 2-4 hiring reviewer personas for a Korean job posting.
Each persona represents a realistic stakeholder (HR, hiring manager, domain expert, etc.).
weight: 0.1-1.0 relative influence. Respond in Korean for text fields.`,
    user: JSON.stringify({
      company: job.company,
      role: job.role,
      requirements: job.requirements,
      preferred: job.preferred,
      responsibilities: job.responsibilities,
      cultureSignals: job.cultureSignals,
      keywords: job.keywords,
    }),
    maxTokens: 2000,
  });

  return (parsed.personas ?? []).slice(0, 4).map((p, i) => ({
    id: `persona-${i + 1}`,
    name: p.name,
    title: p.title,
    focus: p.focus,
    likes: p.likes ?? [],
    redFlags: p.redFlags ?? [],
    weight: typeof p.weight === "number" ? p.weight : 0.5,
  }));
}
