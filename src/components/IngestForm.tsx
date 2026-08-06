"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { JobSummary } from "./JobSummary";
import { saveJob } from "@/lib/session";
import type { JobPosting } from "@/lib/types";

type Mode = "text" | "url" | "file" | "image";

type ProfileMeta = {
  name: string;
  tagline: string;
  portfolioUrl: string;
  experienceCount: number;
  essayCount: number;
  workCount: number;
  notionConnected: boolean;
  anthropicConfigured?: boolean;
};

export function IngestForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("text");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<JobPosting | null>(null);
  const [profile, setProfile] = useState<ProfileMeta | null>(null);

  useEffect(() => {
    fetch("/api/profile")
      .then((r) => r.json())
      .then(setProfile)
      .catch(() => undefined);
  }, []);

  async function onAnalyze() {
    setLoading(true);
    setError(null);
    setJob(null);
    try {
      let res: Response;
      if (mode === "text" || mode === "url") {
        res = await fetch("/api/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            mode === "text" ? { mode: "text", text } : { mode: "url", url },
          ),
        });
      } else {
        if (!file) throw new Error("파일을 선택해 주세요.");
        const form = new FormData();
        form.set("mode", mode);
        form.set("file", file);
        res = await fetch("/api/ingest", { method: "POST", body: form });
      }

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "분석 실패");
      setJob(data.job as JobPosting);
      saveJob(data.job as JobPosting);
    } catch (err) {
      setError(err instanceof Error ? err.message : "분석 실패");
    } finally {
      setLoading(false);
    }
  }

  function goSetup() {
    if (!job) return;
    saveJob(job);
    router.push("/setup");
  }

  const modes: { id: Mode; label: string; hint: string }[] = [
    { id: "text", label: "텍스트", hint: "공고 본문 붙여넣기" },
    { id: "url", label: "링크", hint: "채용 페이지 URL" },
    { id: "file", label: "문서", hint: "PDF · DOCX · TXT" },
    { id: "image", label: "이미지", hint: "스크린샷 OCR" },
  ];

  return (
    <div className="space-y-10">
      <section className="max-w-3xl">
        <p className="animate-rise font-[family-name:var(--font-display)] text-4xl leading-[1.12] tracking-tight text-[var(--ink)] sm:text-6xl">
          자소서 랩
        </p>
        <p className="animate-rise-delay-1 mt-4 max-w-xl text-base leading-relaxed text-[var(--muted)] sm:text-lg">
          어떤 형태의 공고든 올리면 JD를 읽고, 내 포트폴리오·경험에 맞춰
          문항별 초안을 만듭니다.
        </p>
      </section>

      {profile && (
        <div className="animate-rise-delay-2 flex flex-wrap items-center gap-2 text-sm">
          <span className="rounded-full bg-[var(--ink)] px-3 py-1 text-[var(--paper)]">
            {profile.name}
          </span>
          <span className="rounded-full border border-[var(--line)] bg-[var(--surface)] px-3 py-1 text-[var(--muted)]">
            경험 {profile.experienceCount}
          </span>
          <span className="rounded-full border border-[var(--line)] bg-[var(--surface)] px-3 py-1 text-[var(--muted)]">
            프로젝트 {profile.workCount}
          </span>
          <span
            className={`rounded-full border px-3 py-1 ${
              profile.notionConnected
                ? "border-emerald-700/30 bg-emerald-50 text-emerald-800"
                : "border-[var(--line)] bg-[var(--surface)] text-[var(--muted)]"
            }`}
          >
            Notion {profile.notionConnected ? "연결" : "스냅샷"}
          </span>
          {profile.anthropicConfigured === false && (
            <span className="rounded-full border border-amber-700/30 bg-amber-50 px-3 py-1 text-amber-900">
              API 키 필요
            </span>
          )}
          <a
            href={profile.portfolioUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-1 text-[var(--accent)] underline-offset-4 hover:underline"
          >
            포트폴리오 보기
          </a>
        </div>
      )}

      <div className="animate-rise-delay-2 panel space-y-5 p-5 sm:p-6">
        <div>
          <h2 className="text-lg font-medium text-[var(--ink)]">공고 올리기</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            텍스트 · 링크 · 문서 · 이미지 중 편한 방식으로 시작하세요.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {modes.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                setMode(m.id);
                setError(null);
              }}
              className={`rounded-xl border px-3 py-3 text-left transition ${
                mode === m.id
                  ? "border-[var(--ink)] bg-[var(--ink)] text-[var(--paper)]"
                  : "border-[var(--line)] bg-[var(--paper)] text-[var(--ink)] hover:border-[var(--accent)]"
              }`}
            >
              <span className="block text-sm font-medium">{m.label}</span>
              <span
                className={`mt-0.5 block text-xs ${
                  mode === m.id ? "text-[var(--paper)]/70" : "text-[var(--muted)]"
                }`}
              >
                {m.hint}
              </span>
            </button>
          ))}
        </div>

        {mode === "text" && (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={12}
            placeholder="채용 공고 본문을 붙여넣으세요"
            className="input-field min-h-[220px] resize-y"
          />
        )}

        {mode === "url" && (
          <div className="space-y-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://..."
              className="input-field"
            />
            <p className="text-xs text-[var(--muted)]">
              로그인 벽·자바스크립트 렌더링 페이지는 텍스트/스크린샷이 더
              정확합니다.
            </p>
          </div>
        )}

        {(mode === "file" || mode === "image") && (
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper)] px-4 py-10 text-center transition hover:border-[var(--accent)]">
            <span className="text-sm font-medium text-[var(--ink)]">
              {file ? file.name : "파일을 선택하거나 드롭하세요"}
            </span>
            <span className="text-xs text-[var(--muted)]">
              {mode === "image"
                ? "JPEG · PNG · WebP · GIF · 최대 8MB"
                : "PDF · DOCX · TXT · 최대 12MB"}
            </span>
            <input
              type="file"
              className="sr-only"
              accept={
                mode === "image"
                  ? "image/png,image/jpeg,image/webp,image/gif"
                  : ".pdf,.docx,.txt,application/pdf"
              }
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
        )}

        {error && (
          <p className="animate-fade rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        )}

        <button
          type="button"
          disabled={loading}
          onClick={onAnalyze}
          className="btn-primary"
        >
          {loading ? (
            <span className="animate-pulse-soft">공고 분석 중…</span>
          ) : (
            "공고 분석하기"
          )}
        </button>
      </div>

      {job && (
        <div className="animate-fade space-y-4">
          <JobSummary job={job} />
          <button type="button" onClick={goSetup} className="btn-ink">
            문항·제약 설정으로 계속
          </button>
        </div>
      )}
    </div>
  );
}
