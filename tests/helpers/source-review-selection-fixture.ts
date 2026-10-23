import assert from "node:assert/strict";

export function inventedReadingDomainFromPattern(pattern: string): string[] {
  assert.equal(typeof pattern, "string");
  const ids =
    pattern.match(/(?:[ed][1-9]\d*-[1-9]\d*|c[1-9]\d*|o-[sf]\d+)/g) ?? [];
  assert(ids.length > 0);
  assert.equal(new Set(ids).size, ids.length);
  assert(new RegExp(pattern).test(ids.map((id) => "|" + id).join("")));
  return ids;
}

// Encode only invented test drafts. Never consume a provider receipt here.
// Duplicate draft references fail rather than being hidden by the encoder.
export function encodeInventedReviewSelections(wires: any[], requests: any[]) {
  return wires.map((wire, index) => ({
    ...wire,
    checksFormat: "claim_keyed_refs_v7",
    checksByClaim: Object.fromEntries(
      Object.entries(wire.checksByClaim).map(([id, raw]) => {
        const check = raw as any;
        if (!Array.isArray(check.readingRefs)) {
          assert.equal(typeof check.readingSelection, "string");
          return [id, { ...check }];
        }
        const { readingRefs, ...rest } = check;
        assert.equal(new Set(readingRefs).size, readingRefs.length);
        const group = requests[index].claimReadingGroups.find((g: any) =>
          g.claimIds.includes(id),
        );
        const ids: string[] =
          check.verdict === "supported"
            ? (group.supportedReadingIds ?? group.readingIds)
            : group.readingIds;
        assert(readingRefs.every((ref: string) => ids.includes(ref)));
        return [
          id,
          {
            ...rest,
            readingSelection: ids
              .filter((ref) => readingRefs.includes(ref))
              .map((ref) => "|" + ref)
              .join(""),
          },
        ];
      }),
    ),
  }));
}
