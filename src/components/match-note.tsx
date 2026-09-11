import { Check, Clock3, Sparkles, X } from "lucide-react";
import type { MatchAssessment } from "@/lib/domain";
import { assessmentLabels } from "@/lib/match-presentation";

export function MatchNote({
  assessment,
  reason,
}: {
  assessment: MatchAssessment;
  reason: string;
}) {
  const pending = assessment === "preliminary" || assessment === "uncertain";
  const Icon = pending
    ? Clock3
    : assessment === "reviewed"
      ? Check
      : assessment === "rejected" || assessment === "excluded"
        ? X
        : Sparkles;
  return (
    <div className={`match-note${pending ? " needs-review" : ""}`}>
      <Icon size={16} aria-hidden="true" />
      <div>
        <strong>{assessmentLabels[assessment]}</strong>
        <p>{reason}</p>
      </div>
    </div>
  );
}
