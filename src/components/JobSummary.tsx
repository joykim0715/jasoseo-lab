import type { JobPosting } from "@/lib/types";

export function WarningsBanner({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <div className="rounded-xl border border-amber-700/25 bg-amber-50/90 px-4 py-3 text-sm text-amber-950">
      <p className="mb-1 font-medium">추출 주의</p>
      <ul className="list-disc space-y-1 pl-5">
        {warnings.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

export function JobSummary({ job }: { job: JobPosting }) {
  return (
    <div className="panel space-y-5 p-5 sm:p-6">
      <div>
        <p className="text-xs uppercase tracking-[0.16em] text-[var(--muted)]">
          분석된 공고
        </p>
        <h2 className="mt-1 font-[family-name:var(--font-display)] text-2xl leading-snug text-[var(--ink)] sm:text-3xl">
          {job.company}
          <span className="mx-2 text-[var(--line)]">·</span>
          {job.role}
        </h2>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field title="자격 요건" items={job.requirements} />
        <Field title="우대" items={job.preferred} />
        <Field title="주요 업무" items={job.responsibilities} />
        <Field title="키워드" items={job.keywords} />
      </div>
      {job.cultureSignals.length > 0 && (
        <Field title="조직·문화 시그널" items={job.cultureSignals} />
      )}
      <WarningsBanner warnings={job.warnings} />
    </div>
  );
}

function Field({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <p className="mb-1.5 text-sm font-medium text-[var(--ink)]">{title}</p>
      <ul className="space-y-1.5 text-sm leading-relaxed text-[var(--muted)]">
        {items.slice(0, 6).map((item) => (
          <li key={item} className="flex gap-2">
            <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[var(--accent)]" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
