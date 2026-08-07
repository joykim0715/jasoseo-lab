import { NextResponse } from "next/server";
import { llmStatus } from "@/lib/llm";
import { loadCandidateProfile } from "@/lib/profile/loadProfile";

export const runtime = "nodejs";

export async function GET() {
  const { profile, notionConnected } = await loadCandidateProfile();
  const llm = llmStatus();
  return NextResponse.json({
    name: profile.name,
    tagline: profile.tagline,
    portfolioUrl: profile.portfolioUrl,
    experienceCount: profile.experiences.length,
    essayCount: profile.essayArchive.length,
    workCount: profile.works.length,
    notionConnected,
    groqConfigured: llm.groqConfigured,
    openaiConfigured: llm.openaiConfigured,
    geminiConfigured: llm.geminiConfigured,
    anthropicConfigured: false,
    llmPrimary: llm.primary,
    llmFallback: llm.fallback,
  });
}
