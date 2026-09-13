import Link from "next/link";
import { notFound } from "next/navigation";
import { Shell } from "@/components/shell";
import { LotSourceEditor } from "@/components/lot-source-editor";
import { lotSourceEditorData } from "@/lib/lot-source-editor-data";
import { loadLotSourceReview } from "@/lib/lot-source-reviews";
import { HttpError, pageViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";
export default async function LotSourceReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ lot?: string }>;
}) {
  const viewer = await pageViewer(true);
  if (viewer.demo)
    return (
      <Shell viewer={viewer}>
        <section className="panel">
          <h1>Revisione dei lotti</h1>
          <p>
            Disponibile nell’area fondatore autenticata. La demo non legge né
            modifica revisioni reali.
          </p>
        </section>
      </Shell>
    );
  const { id } = await params,
    { lot } = await searchParams;
  const target = lot
    ? {
        kind: "lot",
        publicationId: id,
        sourceProjectId: id.slice(6),
        lotId: lot,
      }
    : { kind: "project", publicationId: id };
  const data = await loadLotSourceReview(target, viewer).catch(
    (error: unknown) => {
      if (error instanceof HttpError && error.status === 404) notFound();
      throw error;
    },
  );
  return (
    <Shell viewer={viewer}>
      <Link href="/admin" className="back-link">
        Torna all’area fondatore
      </Link>
      <LotSourceEditor
        key={`${data.expected.snapshotHash}:${data.expected.targetEventId}:${data.expected.projectBarrierHash}:${lot ?? "project"}`}
        data={lotSourceEditorData(data)}
      />
    </Shell>
  );
}
