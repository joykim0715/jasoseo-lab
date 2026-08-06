import type { Metadata } from "next";
import { Fraunces, Noto_Sans_KR } from "next/font/google";
import "./globals.css";
import { siteName, siteTagline, siteUrl } from "@/lib/site";

const display = Fraunces({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

const body = Noto_Sans_KR({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: `${siteName} — ${siteTagline}`,
    template: `%s · ${siteName}`,
  },
  description:
    "취업 공고를 올리면 JD를 분석하고, 포트폴리오·경험 뱅크에 맞춰 문항별 자기소개서 초안을 작성합니다.",
  applicationName: siteName,
  openGraph: {
    type: "website",
    locale: "ko_KR",
    url: siteUrl,
    siteName,
    title: `${siteName} — ${siteTagline}`,
    description:
      "텍스트·링크·문서·이미지 공고를 분석해 맞춤 자소서 초안을 만듭니다.",
  },
  twitter: {
    card: "summary_large_image",
    title: `${siteName} — ${siteTagline}`,
    description:
      "텍스트·링크·문서·이미지 공고를 분석해 맞춤 자소서 초안을 만듭니다.",
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className={`${display.variable} ${body.variable} h-full`}>
      <body className="min-h-full antialiased">{children}</body>
    </html>
  );
}
