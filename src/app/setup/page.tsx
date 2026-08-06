import { AppShell } from "@/components/AppShell";
import { SetupForm } from "@/components/SetupForm";

export default function SetupPage() {
  return (
    <AppShell step={2}>
      <SetupForm />
    </AppShell>
  );
}
