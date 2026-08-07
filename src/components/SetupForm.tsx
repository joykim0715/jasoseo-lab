"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { JobSummary } from "./JobSummary";
import { buildFreeFormQuestions } from "@/lib/generate/freeForm";
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
  blindSchool: false,
  blindCompany: false,
  blindProject: false,
  blindGpa: false,
  blindPersonal: false,
  blindDemographics: false,
};

function normalizeConstraints(
  raw: Partial<WritingConstraints> | null | undefined,
): WritingConstraints {
  return {
    ...defaultConstraints,
    freeText: typeof raw?.freeText === "string" ? raw.freeText : "",
    blindSchool: Boolean(raw?.blindSchool),
    blindCompany: Boolean(raw?.blindCompany),
    blindProject: Boolean(raw?.blindProject),
    blindGpa: Boolean(raw?.blindGpa),
    blindPersonal: Boolean(raw?.blindPersonal),
    blindDemographics: Boolean(raw?.blindDemographics),
  };
}

const BLIND_OPTIONS = [
  ["blindSchool", "학교명 블라인드"],
  ["blindCompany", "이전 기업명 블라인드"],
  ["blindProject", "프로젝트명 블라인드"],
  ["blindGpa", "학점·석차 비노출"],
  ["blindPersonal", "출신지역·가족관계 비노출"],
  ["blindDemographics", "나이·성별 암시 금지"],
] as const;

export function SetupForm() {
  const router = useRouter();
  const [job, setJob] = useState<JobPosting | null>(null);
  const [freeForm, setFreeForm] = useState(false);
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
      setFreeForm(Boolean(existing.freeForm));
      setQuestions(existing.questions);
      setConstraints(normalizeConstraints(existing.constraints));
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
    if (freeForm) return true;
    if (!questions.length) return false;
    if (questions.some((q) => !q.title.trim())) return false;
    return true;
  }, [questions, freeForm]);

  function onContinue() {
    setError(null);

    let finalQuestions = questions;

    if (freeForm) {
      finalQuestions = buildFreeFormQuestions();
    } else {
      if (!questions.length || questions.some((q) => !q.title.trim())) {
        setError("자소서 문항 구성을 입력해 주세요.");
        return;
      }
      if (questions.some((q) => q.charLimit < 0)) {
        setError("글자 수 제한을 확인해 주세요.");
        return;
      }
    }

    const setup: SetupConfig = {
      freeForm,
      questions: finalQuestions,
      constraints,
    };
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

      <section className="animate-rise-delay-2 panel space-y-3 p-5 sm:p-6">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4"
            checked={freeForm}
            onChange={(e) => setFreeForm(e.target.checked)}
          />
          <span>
            <span className="block text-lg font-medium text-[var(--ink)]">
              자유 양식으로 생성
            </span>
            <span className="mt-1 block text-sm text-[var(--muted)]">
              국내 기업에서 흔한 표준 자소서 항목(성장과정 · 성격 장단점 ·
              지원동기 · 직무역량/경험 · 입사 후 포부)으로 자동 구성합니다.
              체크 시 아래 수동 문항 구성은 비활성화됩니다.
            </span>
          </span>
        </label>
        {freeForm && (
          <ul className="ml-7 list-disc space-y-1 text-sm text-[var(--muted)]">
            <li>성장과정 (800자)</li>
            <li>성격의 장단점 (700자)</li>
            <li>지원동기 (800자)</li>
            <li>직무역량 및 경험 (1000자)</li>
            <li>입사 후 포부 (700자)</li>
          </ul>
        )}
      </section>

      <section
        className={`panel space-y-4 p-5 sm:p-6 transition ${
          freeForm
            ? "pointer-events-none select-none opacity-45 grayscale"
            : ""
        }`}
        aria-disabled={freeForm}
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium text-[var(--ink)]">
              1. 자소서 문항 구성
            </h2>
            <p className="text-sm text-[var(--muted)]">
              {freeForm
                ? "자유 양식 사용 중 — 수동 문항은 적용되지 않습니다."
                : "JD에서 문항이 보이면 초안으로 채워집니다."}
            </p>
          </div>
          <button
            type="button"
            disabled={freeForm}
            onClick={() => setQuestions((q) => [...q, newQuestion()])}
            className="btn-ghost disabled:opacity-40"
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
              {questions.length > 1 && !freeForm && (
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
              disabled={freeForm}
              onChange={(e) =>
                setQuestions((all) =>
                  all.map((x) =>
                    x.id === q.id ? { ...x, title: e.target.value } : x,
                  ),
                )
              }
              placeholder="문항 제목 (예: 지원 동기)"
              className="input-field disabled:bg-[var(--line)]/20"
            />
            <textarea
              value={q.prompt}
              disabled={freeForm}
              onChange={(e) =>
                setQuestions((all) =>
                  all.map((x) =>
                    x.id === q.id ? { ...x, prompt: e.target.value } : x,
                  ),
                )
              }
              rows={2}
              placeholder="문항 상세 프롬프트 (선택)"
              className="input-field disabled:bg-[var(--line)]/20"
            />
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <label className="flex items-center gap-2 text-[var(--muted)]">
                글자 수 제한
                <input
                  type="number"
                  min={0}
                  disabled={freeForm}
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
                  className="input-field w-24 py-1.5 disabled:bg-[var(--line)]/20"
                />
              </label>
              <label className="flex items-center gap-2 text-[var(--muted)]">
                <input
                  type="checkbox"
                  disabled={freeForm}
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
          {freeForm
            ? "자유 양식 항목별 기본 글자 수가 적용됩니다. 수치·성과, 회사·포지션 언급, 존댓말, 경험 날조 금지는 기본 적용됩니다."
            : "글자 수는 문항별로 위에서 설정합니다. 수치·성과, 회사·포지션 언급, 존댓말, 경험 날조 금지는 기본 적용됩니다."}
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
        <p className="text-sm font-medium text-[var(--ink)]">
          블라인드 채용 대응
        </p>
        <p className="text-xs text-[var(--muted)]">
          체크 시 해당 식별 정보를 일반화·비노출 처리합니다. (지원 회사명은
          예외)
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {BLIND_OPTIONS.map(([key, label]) => (
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
