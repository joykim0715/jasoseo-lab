import { NextResponse } from "next/server";
import { loadCandidateProfile } from "@/lib/profile/loadProfile";

export const runtime = "nodejs";

export async function GET() {
  const { profile, notionConnected } = await loadCandidateProfile();
  return NextResponse.json({
    name: profile.name,
    tagline: profile.tagline,
    portfolioUrl: profile.portfolioUrl,
    experienceCount: profile.experiences.length,
    essayCount: profile.essayArchive.length,
    workCount: profile.works.length,
    notionConnected,
    anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
  });
}
