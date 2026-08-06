import { AppShell } from "@/components/AppShell";
import { ResultView } from "@/components/ResultView";

export default function ResultPage() {
  return (
    <AppShell step={3}>
      <ResultView />
    </AppShell>
  );
}
