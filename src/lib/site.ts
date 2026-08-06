/** 배포 URL. Vercel 환경변수 NEXT_PUBLIC_SITE_URL 로 덮어쓰기 */
export const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ??
  "https://jasoseo-lab.vercel.app";

export const portfolioUrl =
  process.env.NEXT_PUBLIC_PORTFOLIO_URL?.replace(/\/$/, "") ??
  "https://kiminhong-portfolio.vercel.app";

export const siteName = "자소서 랩";
export const siteTagline = "JD 분석 · 맞춤 초안";
