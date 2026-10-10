import { publicationTextBlocks } from "@/lib/publication-text";

/** Escaped React text, never HTML or a rewritten summary. */
export function PublicationText({
  text,
  lang,
  className = "",
}: {
  text: string;
  lang?: string;
  className?: string;
}) {
  return (
    <div className={`publication-text ${className}`.trim()} lang={lang}>
      {publicationTextBlocks(text).map((block, index) =>
        block.text.trim() ? (
          <p
            key={index}
            className={
              block.kind === "heading" ? "publication-text-heading" : undefined
            }
          >
            {block.kind === "heading" ? (
              <strong>{block.text}</strong>
            ) : (
              block.text
            )}
          </p>
        ) : (
          block.text
        ),
      )}
    </div>
  );
}
