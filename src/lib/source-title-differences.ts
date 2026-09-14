// A display-only comparison of codes printed in translations of the same
// title. It does not classify work, choose a translation, or decide a review.
export type SourceTitleTranslation = {
  group: string;
  path: string;
  language: "it" | "de" | "fr" | "en";
  text: string;
};
export type TitleCodeEvidence = SourceTitleTranslation & {
  code: string;
  start: number;
  end: number;
};
export type TitleCodeDifference = {
  first: TitleCodeEvidence;
  second: TitleCodeEvidence;
};
const knownLanguage = (v: unknown): v is SourceTitleTranslation["language"] =>
  typeof v === "string" && ["it", "de", "fr", "en"].includes(v);

export function legacyTitleTranslations(
  value: unknown,
): SourceTitleTranslation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return [];
    const e = entry as Record<string, unknown>;
    if (
      !knownLanguage(e.language) ||
      typeof e.path !== "string" ||
      typeof e.text !== "string" ||
      !e.text.trim() ||
      !e.path.endsWith(`.title.${e.language}`)
    )
      return [];
    return [
      {
        group: e.path.slice(0, -e.language.length - 1),
        path: e.path,
        language: e.language,
        text: e.text,
      },
    ];
  });
}

export function documentaryTitleTranslations(
  texts: readonly { path: string; text: string; scope: "project" | "lot" }[],
): SourceTitleTranslation[] {
  return texts.flatMap((entry) => {
    const match = /\/title\/(it|de|fr|en)$/.exec(entry.path);
    if (!match || !knownLanguage(match[1]) || !entry.text.trim()) return [];
    return [
      {
        group: `${entry.scope}:${entry.path.slice(0, -match[1].length - 1)}`,
        path: entry.path,
        text: entry.text,
        language: match[1],
      },
    ];
  });
}

function singleCode(title: SourceTitleTranslation): TitleCodeEvidence | null {
  // BKP/CFC/CCC are language names of the execution-based cost structure.
  // Exclude eBKP/eCCC and unlabelled numbers. No code dictionary is copied.
  const anchors = [
    ...title.text.matchAll(
      /(?<![\p{L}\p{N}_-])(?:BKP|CFC|CCC)\s*:?\s*(\d{2,3}(?:\.\d)?)(?![\p{L}\p{N}_.])/giu,
    ),
  ];
  if (anchors.length !== 1) return null;
  const anchor = anchors[0];
  const tail = title.text.slice(anchor.index! + anchor[0].length);
  // Lists/ranges need their own interpretation; never compare just their
  // first number as if it described the entire title.
  if (
    /^\s*(?:[/+,&;–—-]\s*|(?:bis|à|a|e|et|und|and|to)\s+)(?:\d|BKP\b|CFC\b|CCC\b)/iu.test(
      tail,
    ) ||
    /^\s+\d/.test(tail)
  )
    return null;
  const start = anchor.index! + anchor[0].lastIndexOf(anchor[1]);
  return { ...title, code: anchor[1], start, end: start + anchor[1].length };
}

export function findTitleCodeDifferences(
  titles: readonly SourceTitleTranslation[],
): TitleCodeDifference[] {
  const groups = new Map<string, TitleCodeEvidence[]>();
  for (const title of titles) {
    const evidence = singleCode(title);
    if (!evidence) continue;
    const group = groups.get(title.group) ?? [];
    group.push(evidence);
    groups.set(title.group, group);
  }
  const differences: TitleCodeDifference[] = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const first = group[i],
          second = group[j];
        if (first.language === second.language) continue;
        const a = first.code.replace(".", ""),
          b = second.code.replace(".", "");
        // A group and its more precise child are compatible, not evidence
        // that the published descriptions disagree.
        if (a.startsWith(b) || b.startsWith(a)) continue;
        differences.push({ first, second });
      }
    }
  }
  return differences;
}
