// Foglio retains the explicit simap publication number (project-edition).
// simap's projectId is an opaque UUID: even a numeric or exponent-like tail
// says nothing about publication order.
export function sourceEdition(value: { source: string; projectId?: string }) {
  if (value.source !== "foglio-ti") return 0;
  const suffix = value.projectId?.match(/^\d+-(\d+)$/)?.[1];
  if (!suffix) return 0;
  const edition = Number(suffix);
  return Number.isSafeInteger(edition) ? edition : 0;
}
