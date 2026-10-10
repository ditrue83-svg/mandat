import {
  originalClauseTextParts,
  originalClauseFieldLabel,
} from "./source-clause-literals";

type Original = {
  id: string;
  scope: string;
  rawPath: string;
  text: string;
  startUtf16: number;
  endUtf16: number;
};
// Preserve every literal byte; attach only the original fragments that actually
// overlap each rendered piece. A whole-family reference list is not a witness
// that an arbitrary continuation contains a specific fragment's facts.
export function projectOriginalClauseDetailEvidence<
  T extends {
    explanation: string;
    originalTextContinuation?: readonly string[];
    sourceRefs: readonly string[];
    scope: string;
  },
>(details: readonly T[], originals: readonly Original[]) {
  return details.flatMap(({ originalTextContinuation, ...detail }) => {
    if (!originalTextContinuation?.length)
      return [{ ...detail, sourceRefs: [...detail.sourceRefs] }];
    const selected = detail.sourceRefs.map((ref) => {
      const original = originals.find((p) => p.id === ref);
      if (!original || original.scope !== detail.scope)
        throw Error("Literal piece has unknown or foreign original");
      return original;
    });
    const parts = [detail.explanation, ...originalTextContinuation];
    const verified = originalClauseTextParts(selected);
    if (!verified || JSON.stringify(verified) !== JSON.stringify(parts))
      throw Error("Literal piece provenance requires unchanged complete text");
    const fields = new Map<string, Original[]>();
    for (const p of selected)
      fields.set(p.rawPath, [...(fields.get(p.rawPath) ?? []), p]);
    const spans: { id: string; start: number; end: number }[] = [];
    const fieldStarts: number[] = [];
    let cursor = 0;
    const whole = parts.join("");
    for (const [path, field] of fields) {
      fieldStarts.push(cursor);
      const ordered = [...field].sort((a, b) => a.startUtf16 - b.startUtf16);
      const raw = ordered.map((p) => p.text).join("");
      const language = path.match(/\/(de|en|fr|it|rm)$/)?.[1];
      const label = originalClauseFieldLabel(path, [...fields.keys()]);
      const prefix = fields.size > 1 || !language ? label + ": " : "";
      const unit =
        /\/(?:offerValidityDeadlineDays|contractDays|executionDays)$/.test(
          path,
        ) && /^\d+(?:\.\d+)?$/.test(raw)
          ? Number(raw) === 1
            ? " giorno"
            : " giorni"
          : "";
      const rendered = prefix + raw + unit;
      if (whole.slice(cursor, cursor + rendered.length) !== rendered)
        throw Error("Literal field order or text changed");
      for (const p of ordered)
        spans.push({
          id: p.id,
          start: cursor + prefix.length + p.startUtf16,
          end:
            cursor +
            prefix.length +
            p.endUtf16 +
            (unit && p === ordered.at(-1) ? unit.length : 0),
        });
      cursor += rendered.length + 1;
    }
    let offset = 0;
    // Split an existing literal piece at original field boundaries as well.
    // DE and IT rules remain separate witnesses; no byte, language label,
    // newline, proposition or source span is added or removed.
    const separated = parts.flatMap((part) => {
      const end = offset + part.length;
      const cuts = [
        offset,
        ...fieldStarts.filter((start) => start > offset && start < end),
        end,
      ];
      offset = end;
      return cuts
        .slice(0, -1)
        .map((start, i) => whole.slice(start, cuts[i + 1]));
    });
    offset = 0;
    return separated.map((explanation) => {
      const end = offset + explanation.length;
      const refs = spans
        .filter((p) => p.start < end && p.end > offset)
        .map((p) => p.id);
      if (!refs.length)
        throw Error("Literal continuation has no original fragment evidence");
      offset = end;
      return {
        ...detail,
        explanation,
        sourceRefs: [...new Set(refs)],
        lf: true,
      };
    });
  });
}
