"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { JobSummary } from "./JobSummary";
import { loadJob, loadSetup, saveSetup } from "@/lib/session";
import type {
  EssayQuestion,
  JobPosting,
  SetupConfig,
  WritingConstraints,
} from "@/lib/types";

function newQuestion(partial?: Partial<EssayQuestion>): EssayQuestion {
  return {
    id: crypto.randomUUID(),
    title: partial?.title ?? "",
    prompt: partial?.prompt ?? "",
    charLimit: partial?.charLimit ?? 1000,
    countSpaces: partial?.countSpaces ?? true,
  };
}

const defaultConstraints: WritingConstraints = {
  freeText: "",
  requireNumbers: true,
  mentionCompany: true,
  formalTone: true,
  noFabrication: true,
};

export function SetupForm() {
  const router = useRouter();
  const [job, setJob] = useState<JobPosting | null>(null);
  const [questions, setQuestions] = useState<EssayQuestion[]>([newQuestion()]);
  const [constraints, setConstraints] =
    useState<WritingConstraints>(defaultConstraints);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const j = loadJob();
    if (!j) {
      router.replace("/");
      return;
    }
    setJob(j);

    const existing = loadSetup();
    if (existing) {
      setQuestions(existing.questions);
      setConstraints(existing.constraints);
      return;
    }

    if (j.essayQuestionsHint.length) {
      setQuestions(
        j.essayQuestionsHint.map((hint) =>
          newQuestion({ title: hint, prompt: hint }),
        ),
      );
    }
  }, [router]);

  const ready = useMemo(() => {
    if (!questions.length) return false;
    if (questions.some((q) => !q.title.trim())) return false;
    if (!constraints.freeText.trim() && !hasAnyConstraintFlag(constraints)) {
      return false;
    }
    return true;
  }, [questions, constraints]);

  function onContinue() {
    setError(null);
    if (!questions.length || questions.some((q) => !q.title.trim())) {
      setError("자소서 문항 구성을 입력해 주세요.");
      return;
    }
    if (questions.some((q) => q.charLimit < 0)) {
      setError("글자 수 제한을 확인해 주세요.");
      return;
    }
    if (!constraints.freeText.trim() && !hasAnyConstraintFlag(constraints)) {
      setError("작성 제약 조건(체크 또는 자유 입력)을 설정해 주세요.");
      return;
    }

    const setup: SetupConfig = { questions, constraints };
    saveSetup(setup);
    router.push("/result");
  }

  if (!job) {
    return (
      <p className="animate-pulse-soft text-[var(--muted)]">
        공고 데이터를 불러오는 중…
      </p>
    );
  }

  return (
    <div className="space-y-8">
      <section className="animate-rise">
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-[var(--ink)] sm:text-4xl">
          생성 전 필수 설정
        </h1>
        <p className="mt-2 max-w-2xl text-[var(--muted)]">
          문항 구성 · 글자 수 · 제약 조건을 모두 확인한 뒤에만 초안이
          생성됩니다.
        </p>
      </section>

      <div className="animate-rise-delay-1">
        <JobSummary job={job} />
      </div>

      <section className="animate-rise-delay-2 panel space-y-4 p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium text-[var(--ink)]">
              1. 자소서 문항 구성
            </h2>
            <p className="text-sm text-[var(--muted)]">
              JD에서 문항이 보이면 초안으로 채워집니다.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setQuestions((q) => [...q, newQuestion()])}
            className="btn-ghost"
          >
            + 문항
          </button>
        </div>

        {questions.map((q, idx) => (
          <div
            key={q.id}
            className="space-y-3 rounded-xl border border-[var(--line)] bg-[var(--paper)] p-4"
          >
            <div className="flex items-center justify-between">
              <p className="text-sm text-[var(--muted)]">문항 {idx + 1}</p>
              {questions.length > 1 && (
                <button
                  type="button"
                  className="text-xs text-[var(--danger)]"
                  onClick={() =>
                    setQuestions((all) => all.filter((x) => x.id !== q.id))
                  }
                >
                  삭제
                </button>
              )}
            </div>
            <input
              value={q.title}
              onChange={(e) =>
                setQuestions((all) =>
                  all.map((x) =>
                    x.id === q.id ? { ...x, title: e.target.value } : x,
                  ),
                )
              }
              placeholder="문항 제목 (예: 지원 동기)"
              className="input-field"
            />
            <textarea
              value={q.prompt}
              onChange={(e) =>
                setQuestions((all) =>
                  all.map((x) =>
                    x.id === q.id ? { ...x, prompt: e.target.value } : x,
                  ),
                )
              }
              rows={2}
              placeholder="문항 상세 프롬프트 (선택)"
              className="input-field"
            />
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <label className="flex items-center gap-2 text-[var(--muted)]">
                글자 수 제한
                <input
                  type="number"
                  min={0}
                  value={q.charLimit}
                  onChange={(e) =>
                    setQuestions((all) =>
                      all.map((x) =>
                        x.id === q.id
                          ? { ...x, charLimit: Number(e.target.value) || 0 }
                          : x,
                      ),
                    )
                  }
                  className="input-field w-24 py-1.5"
                />
              </label>
              <label className="flex items-center gap-2 text-[var(--muted)]">
                <input
                  type="checkbox"
                  checked={q.countSpaces}
                  onChange={(e) =>
                    setQuestions((all) =>
                      all.map((x) =>
                        x.id === q.id
                          ? { ...x, countSpaces: e.target.checked }
                          : x,
                      ),
                    )
                  }
                />
                공백 포함
              </label>
              <span className="text-xs text-[var(--muted)]">0 = 제한 없음</span>
            </div>
          </div>
        ))}
      </section>

      <section className="panel space-y-3 p-5 sm:p-6">
        <h2 className="text-lg font-medium text-[var(--ink)]">
          2–3. 작성 제약 조건
        </h2>
        <p className="text-sm text-[var(--muted)]">
          글자 수는 문항별로 위에서 설정합니다. 아래는 전체 작성 톤·규칙입니다.
        </p>
        <textarea
          value={constraints.freeText}
          onChange={(e) =>
            setConstraints((c) => ({ ...c, freeText: e.target.value }))
          }
          rows={3}
          placeholder="추가 제약 (예: 팀 협업 강조, 이직 사유 언급 금지…)"
          className="input-field"
        />
        <div className="grid gap-2 sm:grid-cols-2">
          {(
            [
              ["requireNumbers", "수치·성과 지표 포함"],
              ["mentionCompany", "회사·포지션 자연스럽게 언급"],
              ["formalTone", "존댓말·격식체"],
              ["noFabrication", "경험 날조 금지"],
            ] as const
          ).map(([key, label]) => (
            <label
              key={key}
              className="flex items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm"
            >
              <input
                type="checkbox"
                checked={constraints[key]}
                onChange={(e) =>
                  setConstraints((c) => ({ ...c, [key]: e.target.checked }))
                }
              />
              {label}
            </label>
          ))}
        </div>
      </section>

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={!ready}
        onClick={onContinue}
        className="btn-ink"
      >
        결과 생성 화면으로
      </button>
    </div>
  );
}

function hasAnyConstraintFlag(c: WritingConstraints) {
  return (
    c.requireNumbers || c.mentionCompany || c.formalTone || c.noFabrication
  );
}
