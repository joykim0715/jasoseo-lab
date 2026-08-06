import { AppShell } from "@/components/AppShell";
import { IngestForm } from "@/components/IngestForm";

export default function HomePage() {
  return (
    <AppShell step={1}>
      <IngestForm />
    </AppShell>
  );
}
