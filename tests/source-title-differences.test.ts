import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  documentaryTitleTranslations,
  findTitleCodeDifferences,
  legacyTitleTranslations,
  type SourceTitleTranslation,
} from "../src/lib/source-title-differences";
import { SourceTitleNotices } from "../src/components/source-title-notices";

// Invented source titles only; these are display checks, not semantic labels.
function pair(de: string, fr: string): SourceTitleTranslation[] {
  return [
    {
      group: "project-info.title",
      path: "project-info.title.de",
      language: "de",
      text: de,
    },
    {
      group: "project-info.title",
      path: "project-info.title.fr",
      language: "fr",
      text: fr,
    },
  ];
}
describe("published title code differences", () => {
  it("keeps the complete text, path and exact Unicode offsets of both translations", () => {
    const titles = pair(
      "🧰 Entwurf BKP 241.1 Technik",
      "Titre inventé CFC : 281.6 Revêtement",
    );
    titles.forEach(Object.freeze);
    Object.freeze(titles);
    const before = JSON.stringify(titles),
      found = findTitleCodeDifferences(titles);
    expect(found).toHaveLength(1);
    for (const e of [found[0].first, found[0].second]) {
      expect(e.text.slice(e.start, e.end)).toBe(e.code);
      expect(titles).toContainEqual({
        group: e.group,
        path: e.path,
        language: e.language,
        text: e.text,
      });
    }
    expect(JSON.stringify(titles)).toBe(before);
  });
  it("does not treat equal codes or a group and child as a disagreement", () => {
    for (const [a, b] of [
      ["271", "271"],
      ["27", "271"],
      ["271", "271.0"],
      ["271.0", "27"],
    ])
      expect(
        findTitleCodeDifferences(pair(`BKP ${a} A`, `CFC ${b} B`)),
      ).toEqual([]);
  });
  it("does not turn absent, other-system or malformed codes into a clean-source verdict", () => {
    for (const title of [
      "Prestazione senza codice",
      "CPV 27100000",
      "eBKP 271",
      "e-BKP 271",
      "eCCC 271",
      "BKP 2710",
      "CFC 271.01",
      "BKP 271a",
    ])
      expect(findTitleCodeDifferences(pair(title, "CFC 281.6 B"))).toEqual([]);
    expect(
      renderToStaticMarkup(
        createElement(SourceTitleNotices, {
          titles: pair("Senza codice", "Sans code"),
        }),
      ),
    ).toBe("");
  });
  it("does not compare the first item of a list or range as the whole title", () => {
    for (const title of [
      "BKP 271/272 A",
      "BKP 271, 272 A",
      "BKP 271 + 272 A",
      "BKP 271–272 A",
      "BKP 271 bis 272 A",
      "CFC 271 à 272 A",
      "BKP 271 und 272 A",
      "BKP 271 A / BKP 272 B",
    ])
      expect(findTitleCodeDifferences(pair(title, "CFC 281.6 B"))).toEqual([]);
  });
  it("compares only translations of the same source field and target", () => {
    const titles = documentaryTitleTranslations([
      { scope: "project", path: "/base/title/de", text: "BKP 241.1 A" },
      { scope: "lot", path: "/base/title/fr", text: "CFC 281.6 B" },
      { scope: "project", path: "/project-info/title/fr", text: "CFC 281.6 C" },
      {
        scope: "project",
        path: "/procurement/orderDescription/fr",
        text: "CFC 281.6 D",
      },
      { scope: "lot", path: "/lots/a/title/de", text: "BKP 241.1 E" },
      { scope: "lot", path: "/lots/b/title/fr", text: "CFC 281.6 F" },
    ]);
    expect(findTitleCodeDifferences(titles)).toEqual([]);
    expect(
      findTitleCodeDifferences([
        ...titles,
        {
          group: "project:/base/title",
          path: "/base/title/fr",
          language: "fr",
          text: "CFC 281.6 G",
        },
      ]),
    ).toHaveLength(1);
  });
  it("does not compare two records in the same language or invent missing legacy provenance", () => {
    const sameLanguage = pair("BKP 241.1 A", "CFC 281.6 B").map((t) => ({
      ...t,
      language: "de" as const,
    }));
    expect(findTitleCodeDifferences(sameLanguage)).toEqual([]);
    expect(
      legacyTitleTranslations([
        null,
        { text: "BKP 241.1", language: "de" },
        { text: "CFC 281.6", language: "fr", path: "description.fr" },
      ]),
    ).toEqual([]);
    expect(
      findTitleCodeDifferences(
        legacyTitleTranslations(pair("BKP 241.1 A", "CFC 281.6 B")),
      ),
    ).toHaveLength(1);
  });
  it("recognizes CCC as a language name without copying or inferring a work dictionary", () => {
    const titles = pair("BKP 241.1 A", "CCC 281.6 B");
    titles[1] = { ...titles[1], language: "it", path: "project-info.title.it" };
    expect(findTitleCodeDifferences(titles)).toHaveLength(1);
  });
  it("renders both originals as escaped text and offers no action that changes the source", () => {
    const html = renderToStaticMarkup(
      createElement(SourceTitleNotices, {
        titles: pair(
          "BKP 241.1 <script>testo</script>",
          "CFC 281.6 <img src=x onerror=alert(1)>",
        ),
      }),
    );
    expect(html).toContain("Codici diversi nei titoli originali");
    expect(html).toContain("<mark>241.1</mark>");
    expect(html).toContain("<mark>281.6</mark>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/<(script|img|button|input|form)\b/);
    expect(html).toContain("non stabilisce quale versione sia corretta");
  });
});
