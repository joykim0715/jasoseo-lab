"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CopyButton } from "./CopyButton";
import { loadJob, loadResult, loadSetup, saveResult } from "@/lib/session";
import type { GenerateResult, JobPosting, SetupConfig } from "@/lib/types";

export function ResultView() {
  const router = useRouter();
  const [job, setJob] = useState<JobPosting | null>(null);
  const [setup, setSetup] = useState<SetupConfig | null>(null);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [regenId, setRegenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPersonas, setShowPersonas] = useState(false);
  const [markdown, setMarkdown] = useState(false);

  useEffect(() => {
    const j = loadJob();
    const s = loadSetup();
    if (!j || !s) {
      router.replace("/");
      return;
    }
    setJob(j);
    setSetup(s);
    const existing = loadResult();
    if (existing) setResult(existing);
  }, [router]);

  async function generate() {
    if (!job || !setup) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job, setup }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "생성 실패");
      setResult(data.result);
      saveResult(data.result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "생성 실패");
    } finally {
      setLoading(false);
    }
  }

  async function regenerate(questionId: string) {
    if (!job || !setup || !result) return;
    setRegenId(questionId);
    setError(null);
    try {
      const res = await fetch("/api/generate/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job,
          setup,
          questionId,
          personas: result.personas,
          previous: result,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "재생성 실패");
      setResult(data.result);
      saveResult(data.result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "재생성 실패");
    } finally {
      setRegenId(null);
    }
  }

  const allText =
    result?.answers
      .map((a, i) => {
        if (markdown) {
          return `## ${i + 1}. ${a.title}\n\n${a.body}`;
        }
        return `[${i + 1}. ${a.title}]\n\n${a.body}`;
      })
      .join("\n\n--------------------\n\n") ?? "";

  if (!job || !setup) {
    return (
      <p className="animate-pulse-soft text-[var(--muted)]">세션을 불러오는 중…</p>
    );
  }

  return (
    <div className="space-y-8">
      <section className="animate-rise flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-3xl text-[var(--ink)] sm:text-4xl">
            맞춤 자소서
          </h1>
          <p className="mt-2 text-[var(--muted)]">
            {job.company} · {job.role}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => router.push("/setup")}
            className="btn-ghost"
          >
            문항 수정
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={generate}
            className="btn-primary"
          >
            {loading ? (
              <span className="animate-pulse-soft">생성 중…</span>
            ) : result ? (
              "전체 다시 생성"
            ) : (
              "페르소나 분석 후 생성"
            )}
          </button>
        </div>
      </section>

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}

      {result && (
        <>
          <div className="animate-fade flex flex-wrap items-center gap-3">
            <CopyButton text={allText} label="전체 복사" />
            <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
              <input
                type="checkbox"
                checked={markdown}
                onChange={(e) => setMarkdown(e.target.checked)}
              />
              Markdown 형식
            </label>
            <button
              type="button"
              onClick={() => setShowPersonas((v) => !v)}
              className="text-sm text-[var(--accent)] underline-offset-4 hover:underline"
            >
              {showPersonas ? "페르소나 접기" : "페르소나·매칭 보기"}
            </button>
          </div>

          {showPersonas && (
            <div className="panel space-y-3 p-5 text-sm">
              <pre className="whitespace-pre-wrap font-sans leading-relaxed text-[var(--ink)]">
                {result.personaFeedback}
              </pre>
              <div>
                <p className="mb-1 font-medium">경험 매칭</p>
                <ul className="space-y-1 text-[var(--muted)]">
                  {result.matchingNotes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <div className="space-y-5">
            {result.answers.map((a, idx) => (
              <article key={a.questionId} className="panel animate-fade p-5 sm:p-6">
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs tracking-wide text-[var(--muted)]">
                      문항 {idx + 1}
                    </p>
                    <h2 className="text-lg font-medium text-[var(--ink)]">
                      {a.title}
                    </h2>
                    <p className="mt-1 text-sm text-[var(--muted)]">
                      {a.charCount}
                      {a.charLimit > 0 ? ` / ${a.charLimit}` : ""}자
                      {a.countSpaces ? " (공백 포함)" : " (공백 제외)"}
                      {!a.withinLimit && (
                        <span className="ml-2 text-[var(--danger)]">제한 초과</span>
                      )}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <CopyButton text={a.body} label="문항 복사" />
                    <button
                      type="button"
                      disabled={regenId === a.questionId}
                      onClick={() => regenerate(a.questionId)}
                      className="btn-ghost"
                    >
                      {regenId === a.questionId ? "재생성…" : "다시 생성"}
                    </button>
                  </div>
                </div>

                {a.constraintNotes.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-2">
                    {a.constraintNotes.map((n) => (
                      <span
                        key={n}
                        className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs text-amber-900"
                      >
                        {n}
                      </span>
                    ))}
                  </div>
                )}

                <pre className="whitespace-pre-wrap font-sans text-[15px] leading-7 text-[var(--ink)]">
                  {a.body}
                </pre>
              </article>
            ))}
          </div>
        </>
      )}

      {!result && !loading && (
        <div className="panel animate-rise-delay-1 p-8 text-center">
          <p className="font-[family-name:var(--font-display)] text-2xl text-[var(--ink)]">
            초안을 만들 준비가 됐습니다
          </p>
          <p className="mx-auto mt-2 max-w-md text-sm text-[var(--muted)]">
            JD 기반 다중 페르소나를 세우고, 포트폴리오·경험 뱅크에 맞춰 문항별
            초안을 생성합니다.
          </p>
        </div>
      )}
    </div>
  );
}
