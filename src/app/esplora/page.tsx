import { CatalogView } from "@/components/catalog-view";
import { pageViewer } from "@/lib/viewer";
import { readCatalog, type CatalogFilters } from "@/lib/catalog";

export const dynamic = "force-dynamic";
export default async function Explore({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await pageViewer();
  const raw = await searchParams;
  const input: CatalogFilters = Object.fromEntries(
    Object.entries(raw).filter(([, value]) => typeof value === "string"),
  );
  return (
    <CatalogView viewer={viewer} data={await readCatalog(viewer, input)} />
  );
}
