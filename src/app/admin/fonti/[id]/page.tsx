import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { HttpError, pageViewer } from "@/lib/viewer";
import { loadSourceReviewContext } from "@/lib/source-reviews";
import { sourceReviewEditorData } from "@/lib/source-review-editor-data";
import { Shell } from "@/components/shell";
import { SourceReviewEditor } from "@/components/source-review-editor";

export const dynamic = "force-dynamic";

export default async function SourceReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const viewer = await pageViewer(true);
  if (viewer.demo)
    return (
      <Shell viewer={viewer}>
        <Link href="/admin" className="back-link">
          Torna all’area fondatore
        </Link>
        <section className="panel">
          <h1>Revisione delle fonti</h1>
          <p className="notice">
            La revisione delle fonti è disponibile nell’area fondatore
            autenticata. La demo non legge né modifica revisioni reali.
          </p>
        </section>
      </Shell>
    );
  const { id } = await params;
  const data = await loadSourceReviewContext(id, viewer).catch(
    (error: unknown) => {
      if (error instanceof HttpError && error.status === 404) notFound();
      if (error instanceof HttpError && error.status === 409)
        redirect(`/admin/fonti/${encodeURIComponent(id)}/lotti`);
      throw error;
    },
  );
  return (
    <Shell viewer={viewer}>
      <Link href="/admin" className="back-link">
        Torna all’area fondatore
      </Link>
      <SourceReviewEditor
        key={`${data.expected.eventId ?? "none"}:${data.expected.sourceSnapshotHash}`}
        data={sourceReviewEditorData(data)}
        demo={viewer.demo}
      />
    </Shell>
  );
}
