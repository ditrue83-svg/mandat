import Link from "next/link";
import { z } from "zod";
import { notFound } from "next/navigation";
import { Shell } from "@/components/shell";
import { LotMatchEditor } from "@/components/lot-match-editor";
import { lotMatchEditorData } from "@/lib/lot-match-editor-data";
import {
  loadLotMatchReview,
  lotMatchReviewTarget,
  assessmentReviewTarget,
} from "@/lib/lot-match-reviews";
import { HttpError, pageViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";
export default async function LotMatchReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ companyId: string; publicationId: string }>;
  searchParams: Promise<{ lot?: string }>;
}) {
  const viewer = await pageViewer(true);
  if (viewer.demo)
    return (
      <Shell viewer={viewer}>
        <section className="panel">
          <h1>Valutazione della pertinenza</h1>
          <p>
            Disponibile nell’area fondatore autenticata. La demo non legge né
            modifica valutazioni reali.
          </p>
        </section>
      </Shell>
    );
  const { companyId, publicationId } = await params;
  const { lot } = await searchParams;
  if (lot && !z.uuid().safeParse(lot).success) notFound();
  const loaded = await loadLotMatchReview(
    companyId,
    publicationId,
    viewer,
  ).catch((error: unknown) => {
    if (error instanceof HttpError && error.status === 404) notFound();
    throw error;
  });
  let selected: ReturnType<typeof assessmentReviewTarget> | null = null;
  let unavailable = false;
  try {
    selected = lot
      ? lotMatchReviewTarget(loaded, lot)
      : loaded.project.shape.kind === "project"
        ? assessmentReviewTarget(loaded, { kind: "project", publicationId })
        : null;
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 409) throw error;
    unavailable = true;
  }
  return (
    <Shell viewer={viewer}>
      <Link href="/admin" className="back-link">
        Torna all’area fondatore
      </Link>
      {unavailable && (
        <p className="notice">
          Questo target non è più valutabile nella struttura corrente. Seleziona
          il progetto o un lotto corrente; i giudizi precedenti restano nello
          storico.
        </p>
      )}
      <LotMatchEditor
        key={`${loaded.expected.snapshotHash}:${loaded.expected.shapeEpochToken}:${loaded.expected.profileHash}:${loaded.expected.stateToken}:${loaded.expected.groupToken}:${loaded.expected.projectBindingHash}:${selected?.expected.operationalInputHash ?? "project"}:${lot ?? "project"}`}
        data={lotMatchEditorData(loaded, selected)}
      />
    </Shell>
  );
}
