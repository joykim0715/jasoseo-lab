import Link from "next/link";
import { portfolioUrl, siteName, siteTagline } from "@/lib/site";

export function AppShell({
  children,
  step,
}: {
  children: React.ReactNode;
  step: 1 | 2 | 3;
}) {
  const steps = [
    { n: 1 as const, href: "/", label: "공고 입력" },
    { n: 2 as const, href: "/setup", label: "문항·제약" },
    { n: 3 as const, href: "/result", label: "결과" },
  ];

  return (
    <div className="relative flex min-h-full flex-col">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-28 -top-10 h-[28rem] w-[28rem] rounded-full bg-[var(--wash-a)] blur-3xl" />
        <div className="absolute -right-16 top-28 h-[30rem] w-[30rem] rounded-full bg-[var(--wash-b)] blur-3xl" />
        <div className="absolute bottom-0 left-1/3 h-64 w-64 rounded-full bg-[var(--accent-soft)]/70 blur-3xl" />
        <div className="absolute inset-0 opacity-[0.04] [background-image:radial-gradient(circle_at_1px_1px,var(--ink)_1px,transparent_0)] [background-size:24px_24px]" />
      </div>

      <header className="relative z-10 border-b border-[var(--line)]/60 bg-[var(--paper)]/75 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-4">
          <Link href="/" className="group min-w-0">
            <p className="font-[family-name:var(--font-display)] text-2xl tracking-tight text-[var(--ink)] transition group-hover:text-[var(--accent)]">
              {siteName}
            </p>
            <p className="truncate text-xs text-[var(--muted)]">{siteTagline}</p>
          </Link>

          <nav className="hidden items-center gap-1 sm:flex" aria-label="진행 단계">
            {steps.map((s, i) => {
              const done = step > s.n;
              const active = step === s.n;
              const clickable = s.n <= step;
              const className = `rounded-md px-2.5 py-1 text-sm transition ${
                active
                  ? "bg-[var(--ink)] text-[var(--paper)]"
                  : done
                    ? "text-[var(--accent)]"
                    : "text-[var(--muted)]"
              }`;
              return (
                <span key={s.n} className="flex items-center gap-1">
                  {i > 0 && (
                    <span className="mx-0.5 text-[var(--line)]" aria-hidden>
                      /
                    </span>
                  )}
                  {clickable ? (
                    <Link href={s.href} className={className}>
                      {s.n}. {s.label}
                    </Link>
                  ) : (
                    <span className={className}>
                      {s.n}. {s.label}
                    </span>
                  )}
                </span>
              );
            })}
          </nav>

          <div className="flex items-center gap-2 text-xs text-[var(--muted)] sm:hidden">
            <span className="rounded-md bg-[var(--ink)] px-2 py-1 text-[var(--paper)]">
              {step}/3
            </span>
            <span>{steps[step - 1].label}</span>
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto w-full max-w-5xl flex-1 px-5 py-10">
        {children}
      </main>

      <footer className="relative z-10 border-t border-[var(--line)]/60 bg-[var(--paper)]/80">
        <div className="mx-auto flex max-w-5xl flex-col gap-3 px-5 py-6 text-sm text-[var(--muted)] sm:flex-row sm:items-center sm:justify-between">
          <p>
            <span className="font-[family-name:var(--font-display)] text-[var(--ink)]">
              {siteName}
            </span>
            <span className="mx-2 text-[var(--line)]">·</span>
            김인홍 맞춤 자소서 초안
          </p>
          <div className="flex flex-wrap gap-4">
            <a
              href={portfolioUrl}
              target="_blank"
              rel="noreferrer"
              className="underline-offset-4 hover:text-[var(--accent)] hover:underline"
            >
              포트폴리오
            </a>
            <Link
              href="/"
              className="underline-offset-4 hover:text-[var(--accent)] hover:underline"
            >
              새 공고 시작
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
