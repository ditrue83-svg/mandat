import { createHash } from "node:crypto";
import { z } from "zod";
import type { LotSourceContext } from "./lot-source-context";

export const LOT_OPERATIONAL_EVIDENCE_VERSION = "lot-operational-evidence-v4";
const stable = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stable).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.entries(v)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`)
          .join(",")}}`
      : (JSON.stringify(v) ?? "null");
const hash = (v: unknown) =>
  createHash("sha256").update(stable(v)).digest("hex");
const proofSchema = z
  .object({
    scope: z.enum(["selected_lot", "project_context"]),
    path: z.string(),
    quote: z.string().min(1),
  })
  .strict();
const proofs = z.array(proofSchema).max(12);
export const operationalAnswerSchema = z
  .object({
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable(),
    countryEvidence: proofs,
    canton: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable(),
    cantonEvidence: proofs,
    city: z.string().min(1).nullable(),
    cityEvidence: proofs,
    deadline: z.string().nullable(),
    deadlineAppliesToTarget: z.boolean().nullable(),
    deadlineEvidence: proofs,
    rationale: z.string().min(1),
    issues: z.array(z.string()).max(12),
  })
  .strict();
export type OperationalAnswer = z.infer<typeof operationalAnswerSchema>;
const checkSchema = z
  .object({
    verdict: z.enum(["supported", "not_verifiable", "contradicted"]),
    evidence: proofs,
    rationale: z.string().min(1),
  })
  .strict();
export const operationalReviewSchema = z
  .object({
    checks: z
      .object({
        country: checkSchema,
        canton: checkSchema,
        city: checkSchema,
        deadline: checkSchema,
      })
      .strict(),
    issues: z.array(z.string()).max(12),
  })
  .strict();
type OperationalReview = z.infer<typeof operationalReviewSchema>;
export type OperationalRequest = ReturnType<
  typeof buildOperationalEvidenceRequest
>;
const currentRequests = new WeakSet<object>();

// The entire current source dependency and selected record participate in the
// binding. Quotes retain their original scope; a shared date never becomes a
// fabricated /lots/N field. This derivative does not change archived data.
export function buildOperationalEvidenceRequest(context: LotSourceContext) {
  if (
    context.target.kind !== "lot" ||
    !context.targetContent?.selectedLot ||
    !["not_reviewed", "reviewed"].includes(context.projectBarrier.reason)
  )
    throw new Error("Operational source unavailable");
  const content = context.targetContent,
    selected = content.selectedLot!;
  if (
    !selected.record ||
    typeof selected.record !== "object" ||
    (selected.record as Record<string, unknown>).id !== context.target.lotId
  )
    throw new Error("Operational target mismatch");
  const data = {
    target: context.target,
    sourceDependency: context.dependency,
    selectedPath: selected.path,
    selectedLot: selected.record,
    projectSections: content.projectSections,
    sourceUrl: content.identity.detailUrl,
  };
  const inputHash = hash({ version: LOT_OPERATIONAL_EVIDENCE_VERSION, data });
  const request = {
    version: LOT_OPERATIONAL_EVIDENCE_VERSION,
    inputHash,
    data,
  };
  Object.freeze(data);
  Object.freeze(request);
  currentRequests.add(request);
  return request;
}
function assertCurrent(request: OperationalRequest) {
  if (
    !currentRequests.has(request) ||
    request.version !== LOT_OPERATIONAL_EVIDENCE_VERSION ||
    request.inputHash !== hash({ version: request.version, data: request.data })
  )
    throw new Error("Operational request is not current");
}
function getProofValue(
  request: OperationalRequest,
  p: z.infer<typeof proofSchema>,
): unknown {
  if (p.scope === "selected_lot") {
    const prefix = request.data.selectedPath + "/";
    if (!p.path.startsWith(prefix))
      throw new Error("Operational evidence crosses lot");
    return p.path
      .slice(prefix.length)
      .split("/")
      .map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"))
      .reduce<unknown>(
        (v, k) =>
          v && typeof v === "object" && Object.hasOwn(v, k)
            ? (v as Record<string, unknown>)[k]
            : undefined,
        request.data.selectedLot,
      );
  }
  if (
    !p.path.startsWith("/") ||
    p.path.startsWith("/lots/") ||
    p.path.startsWith("/base/lots/")
  )
    throw new Error("Operational shared evidence scope mismatch");
  return p.path
    .slice(1)
    .split("/")
    .map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>(
      (v, k) =>
        v && typeof v === "object" && Object.hasOwn(v, k)
          ? (v as Record<string, unknown>)[k]
          : undefined,
      request.data.projectSections,
    );
}
function validateProofs(
  request: OperationalRequest,
  values: z.infer<typeof proofs>,
) {
  for (const proof of values) {
    const value = getProofValue(request, proof);
    if (typeof value !== "string" || value !== proof.quote)
      throw new Error("Operational quote not exact original field");
  }
}
function date(value: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("Operational deadline not an explicit instant");
  const [y, m, d] = value.slice(0, 10).split("-").map(Number);
  const calendar = new Date(Date.UTC(y!, m! - 1, d!));
  if (
    calendar.getUTCFullYear() !== y ||
    calendar.getUTCMonth() !== m! - 1 ||
    calendar.getUTCDate() !== d
  )
    throw new Error("Operational deadline invalid calendar");
}
function sharedApplicability(
  request: OperationalRequest,
  evidence: z.infer<typeof proofs>,
) {
  const normalize = (value: string) =>
    value
      .replace(/<[^>]*>/g, " ")
      .normalize("NFC")
      .toLowerCase()
      .replace(/[’‘]/gu, "'")
      .replace(/\s+/gu, " ")
      .trim();
  const notes = (request.data.projectSections as Record<string, unknown>)[
    "project-info"
  ] as Record<string, unknown> | undefined;
  const participant = notes?.participantLotsLimitationNote;
  const grammar: Record<string, RegExp> = {
    it: /^(?:gli offerenti possono candidarsi per un solo lotto o per più lotti\. la valutazione avviene separatamente per ogni lotto\.|l'offerente ha il diritto di presentare un'offerta per più lotti\.)$/u,
    de: /^(?:die anbieter können sich auf eines oder mehrere lose bewerben\. die bewertung erfolgt separat pro los\.|ein anbieter hat das recht, auf mehrere lose ein angebot einzureichen\.)$/u,
    fr: /^(?:les soumissionnaires peuvent présenter une offre pour un ou plusieurs lots\. l'évaluation se fera par lot\.|les soumissionnaires peuvent présenter une offre pour plusieurs lots\.)$/u,
    en: /^tenderers may submit an offer for one or more lots\. evaluation is carried out separately for each lot\.$/u,
  };
  const entries =
    participant &&
    typeof participant === "object" &&
    !Array.isArray(participant)
      ? Object.entries(participant).filter(([, v]) => v !== null && v !== "")
      : [];
  if (
    entries.length &&
    entries.every(
      ([language, value]) =>
        typeof value === "string" && grammar[language]?.test(normalize(value)),
    ) &&
    evidence.some(
      (p) =>
        p.scope === "project_context" &&
        /^\/project-info\/participantLotsLimitationNote\/(it|fr|de|en)$/.test(
          p.path,
        ),
    )
  )
    return true;
  // Explicit, unqualified all-lots submission instruction. Any additional scope
  // exception, numbered subset or unknown clause remains unresolved.
  const allIt =
    /^l'offerta completa per tutti i lotti deve essere presentata entro il (?:[1-9]\d? [a-z]+ \d{4}|\d{2}\.\d{2}\.\d{4})\.$/u;
  const submission = notes?.offerSpecificNote;
  const instructions =
    submission && typeof submission === "object" && !Array.isArray(submission)
      ? Object.entries(submission).filter(([, v]) => v !== null && v !== "")
      : [];
  return (
    instructions.length > 0 &&
    instructions.every(
      ([language, value]) =>
        language === "it" &&
        typeof value === "string" &&
        allIt.test(normalize(value)),
    ) &&
    evidence.some(
      (p) =>
        p.scope === "project_context" &&
        p.path === "/project-info/offerSpecificNote/it",
    )
  );
}
function validateAnswer(request: OperationalRequest, value: unknown) {
  const answer = operationalAnswerSchema.parse(value);
  for (const key of ["country", "canton", "city", "deadline"] as const) {
    const evidence = answer[`${key}Evidence`];
    validateProofs(request, evidence);
    if (answer[key] !== null && !evidence.length)
      throw new Error("Operational fact lacks own evidence");
    if (
      key !== "deadline" &&
      answer[key] !== null &&
      !evidence.some((p) => p.scope === "selected_lot")
    )
      throw new Error("Operational location lacks selected-lot proof");
  }
  if (answer.deadline !== null) {
    date(answer.deadline);
    if (answer.deadlineAppliesToTarget !== true)
      throw new Error("Operational deadline applicability unresolved");
    if (
      !answer.deadlineEvidence.some(
        (p) => /\/offerDeadline$/.test(p.path) && p.quote === answer.deadline,
      )
    )
      throw new Error("Execution period is not an offer deadline");
    if (
      answer.deadlineEvidence.some((p) => p.scope === "project_context") &&
      !answer.deadlineEvidence.some(
        (p) =>
          p.scope === "project_context" &&
          /^\/project-info\/offerSpecificNote\/(it|fr|de|en)$/.test(p.path),
      )
    )
      throw new Error(
        "Shared deadline lacks submission applicability evidence",
      );
    const lot = request.data.selectedLot as Record<string, unknown>;
    const localDates = [
      lot.offerDeadline,
      (lot.dates as Record<string, unknown> | undefined)?.offerDeadline,
    ].filter((v) => v !== undefined && v !== null && v !== "");
    if (
      answer.deadlineEvidence.some(
        (p) => p.scope === "project_context" && /\/offerDeadline$/.test(p.path),
      ) &&
      localDates.some(
        (v) =>
          typeof v !== "string" ||
          explicitOperationalDeadline(v) === null ||
          Date.parse(v) !== Date.parse(answer.deadline!),
      )
    )
      throw new Error("Shared deadline conflicts with selected-lot deadline");
    const sharedDate = answer.deadlineEvidence.some(
      (p) => p.scope === "project_context" && /\/offerDeadline$/.test(p.path),
    );
    if (sharedDate && !sharedApplicability(request, answer.deadlineEvidence))
      throw new Error("Shared deadline lacks explicit lot applicability scope");
  }
  return answer;
}
export function operationalReviewRequest(
  request: OperationalRequest,
  answer: unknown,
) {
  assertCurrent(request);
  return { source: request, answer: validateAnswer(request, answer) };
}
export function recordOperationalEvidence(
  answerInput: unknown,
  reviewInput: unknown,
  request: OperationalRequest,
  metadata: { id: string; at: string; model: string },
) {
  assertCurrent(request);
  const answer = validateAnswer(request, answerInput),
    review = operationalReviewSchema.parse(reviewInput);
  for (const key of ["country", "canton", "city", "deadline"] as const) {
    const check = review.checks[key];
    validateProofs(request, check.evidence);
    if (check.verdict === "contradicted")
      throw new Error("Operational review contradicts reading");
    if (
      answer[key] !== null &&
      (check.verdict !== "supported" || !check.evidence.length)
    )
      throw new Error("Operational review did not verify fact");
    if (
      answer[key] !== null &&
      !answer[`${key}Evidence`].every((p) =>
        check.evidence.some((q) => stable(p) === stable(q)),
      )
    )
      throw new Error("Operational review did not verify each own proof");
  }
  if (answer.issues.length || review.issues.length)
    throw new Error("Operational source conflicts unresolved");
  z.object({
    id: z.string().min(1),
    at: z.iso.datetime({ offset: true }),
    model: z.string().min(1),
  })
    .strict()
    .parse(metadata);
  const unsigned = {
    version: LOT_OPERATIONAL_EVIDENCE_VERSION,
    origin: "ai" as const,
    inputHash: request.inputHash,
    target: request.data.target,
    answer,
    review,
    ...metadata,
  };
  return { ...unsigned, hash: hash(unsigned) };
}
export type OperationalEvidenceRecord = ReturnType<
  typeof recordOperationalEvidence
>;
export function readOperationalEvidence(
  values: readonly unknown[],
  context: LotSourceContext,
): OperationalEvidenceRecord | null {
  let request: OperationalRequest;
  try {
    request = buildOperationalEvidenceRequest(context);
  } catch {
    return null;
  }
  const matches: OperationalEvidenceRecord[] = [];
  for (const value of values) {
    try {
      const v = value as OperationalEvidenceRecord;
      if (
        !v ||
        v.version !== LOT_OPERATIONAL_EVIDENCE_VERSION ||
        v.inputHash !== request.inputHash ||
        v.origin !== "ai"
      )
        continue;
      const { hash: storedHash, ...unsigned } = v;
      if (hash(unsigned) !== storedHash) continue;
      const decoded = recordOperationalEvidence(v.answer, v.review, request, {
        id: v.id,
        at: v.at,
        model: v.model,
      });
      if (decoded.hash !== storedHash) continue;
      matches.push(decoded);
    } catch {
      /* A stale or malformed derivative never removes a gate. */
    }
  }
  return matches.length === 1 ? matches[0]! : null;
}

const instructions = `Leggi solo i dati originali del target ricevuto. Il territorio è quello di esecuzione del lotto, mai quello del committente o una città di partenza. Usa ISO alpha-2 per paese e cantone svizzero; città solo se espressamente sede di esecuzione. Non geocodificare «nei locali dell'offerente». Per ciascun fatto cita il valore stringa INTERO ed ESATTO (incluso HTML) con percorso e ambito originale. Un termine condiviso resta project_context: applicalo al lotto soltanto se le istruzioni di presentazione dell'offerta, il campo offerDeadline e l'ambito della gara lo attestano insieme, senza date locali in conflitto. Periodi di esecuzione, prenotazione, contratto e opzioni non sono scadenze dell'offerta. Controlla tutte le lingue; conserva in issues contraddizioni concrete che incidono sul paese/cantone/città di esecuzione o sulla scadenza e applicabilità della presentazione. Requisiti di idoneità, documenti da fornire e prestazioni professionali sono verificati separatamente: non usarli per contraddire luogo/scadenza senza un nesso materiale esplicito con questi fatti. La conferma di possedere i requisiti con l’offerta non equivale alla consegna di ogni prova documentale allo stesso momento. Non inventare città, idoneità aziendale, importi, fonti esterne o dichiarazioni di assenza. Un valore non dimostrato è null con motivazione. La lettura non è un verdetto di pertinenza.`;
function pathCatalog(request: OperationalRequest) {
  const items: {
    scope: "selected_lot" | "project_context";
    path: string;
    quote: string;
  }[] = [];
  const walk = (
    value: unknown,
    path: string,
    scope: "selected_lot" | "project_context",
  ) => {
    if (typeof value === "string" && value.length)
      items.push({ scope, path, quote: value });
    else if (Array.isArray(value))
      value.forEach((v, i) => walk(v, `${path}/${i}`, scope));
    else if (value && typeof value === "object")
      for (const [key, v] of Object.entries(value))
        walk(
          v,
          `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
          scope,
        );
  };
  walk(request.data.selectedLot, request.data.selectedPath, "selected_lot");
  walk(request.data.projectSections, "", "project_context");
  return items;
}
function responseFormat(request: OperationalRequest, review = false) {
  const paths = pathCatalog(request).map((p) => p.path);
  if (!paths.length) throw new Error("No operational original proof paths");
  const boundedProof = proofSchema.safeExtend({
    path: z.enum(paths as [string, ...string[]]),
  });
  const schema = z.toJSONSchema(
    review ? operationalReviewSchema : operationalAnswerSchema,
  ) as Record<string, unknown>;
  const proofDefinition = z.toJSONSchema(boundedProof);
  delete proofDefinition.$schema;
  schema.$defs = { originalProof: proofDefinition };
  const properties = schema.properties as Record<
    string,
    Record<string, unknown>
  >;
  for (const key of ["country", "canton", "city", "deadline"] as const) {
    const evidence = review
      ? (
          (
            properties.checks!.properties as Record<
              string,
              Record<string, unknown>
            >
          )[key]!.properties as Record<string, Record<string, unknown>>
        ).evidence!
      : properties[`${key}Evidence`]!;
    evidence.items = { $ref: "#/$defs/originalProof" };
  }
  return {
    type: "json_schema" as const,
    json_schema: {
      name: review ? "lot_operational_review" : "lot_operational_reading",
      strict: true as const,
      schema,
    },
  };
}
type DictionaryNode =
  | null
  | boolean
  | number
  | ["s", number]
  | ["a", DictionaryNode[]]
  | ["o", [string, DictionaryNode][]]
  | ["u"];
function dictionarySource(
  request: OperationalRequest,
  answer?: OperationalAnswer,
) {
  const strings: string[] = [],
    indexes = new Map<string, number>();
  const stringId = (value: string) => {
    let id = indexes.get(value);
    if (id === undefined) {
      id = strings.length;
      strings.push(value);
      indexes.set(value, id);
    }
    return id;
  };
  const encode = (value: unknown): DictionaryNode => {
    if (typeof value === "string") return ["s", stringId(value)];
    if (value === undefined) return ["u"];
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "number"
    )
      return value;
    if (Array.isArray(value)) return ["a", value.map(encode)];
    return [
      "o",
      Object.entries(value as Record<string, unknown>).map(([key, v]) => [
        key,
        encode(v),
      ]),
    ];
  };
  const { selectedLot, projectSections, ...binding } = request.data;
  const source = {
    encoding: "original-dictionary-v1" as const,
    binding,
    selectedLot: encode(selectedLot),
    projectSections: encode(projectSections),
    strings,
  };
  const catalog = pathCatalog(request).map(
    (p) => [p.scope, p.path, stringId(p.quote)] as const,
  );
  const reading = answer ? encode(answer) : undefined;
  return {
    source,
    originalProofCatalog: catalog,
    ...(reading ? { reading } : {}),
  };
}
// Lossless decoding utility for the collaudo runner and capacity regressions.
// Decoding is not validation/approval: native evidence validators still own that.
export function decodeOperationalTaskPrompt(prompt: string) {
  const data = JSON.parse(prompt),
    dictionary = data.source;
  if (
    dictionary.encoding !== "original-dictionary-v1" ||
    !Array.isArray(dictionary.strings)
  )
    throw new Error("Unsupported original source encoding");
  const decode = (node: DictionaryNode): unknown => {
    if (!Array.isArray(node)) return node;
    if (node[0] === "s") {
      const value = dictionary.strings[node[1] as number];
      if (typeof value !== "string")
        throw new Error("Original string reference invalid");
      return value;
    }
    if (node[0] === "u") return undefined;
    if (node[0] === "a") return (node[1] as DictionaryNode[]).map(decode);
    if (node[0] === "o")
      return Object.fromEntries(
        (node[1] as [string, DictionaryNode][]).map(([key, value]) => [
          key,
          decode(value),
        ]),
      );
    throw new Error("Original source node invalid");
  };
  return {
    source: {
      ...dictionary.binding,
      selectedLot: decode(dictionary.selectedLot),
      projectSections: decode(dictionary.projectSections),
    } as OperationalRequest["data"],
    originalProofCatalog: (
      data.originalProofCatalog as [string, string, number][]
    ).map(([scope, path, id]) => ({
      scope,
      path,
      quote: dictionary.strings[id],
    })),
    ...(data.reading
      ? { reading: decode(data.reading) as OperationalAnswer }
      : {}),
  };
}
const pathInstructions =
  " I dati originali sono losslessly codificati una volta nel dizionario source.strings. Ricostruisci i nodi: ['s',indice] è la stringa originale INTERA a quell'indice; ['a',lista] è un array; ['o',coppie chiave/nodo] è un oggetto; ['u'] è undefined; null, false, true e numeri sono valori originali. source.binding conserva target e dipendenze; selectedLot e projectSections conservano tutta la struttura. originalProofCatalog contiene tuple [scope,percorso originale,indice stringa]: cita il valore originale INTERO del dizionario, mai indice o codice. La reading della review usa lo stesso dizionario, senza duplicare citazioni. Non prefissare /projectSections o /selectedLot e non inventare percorsi. Non sono riassunti, tutti gli originali inclusi null e false sono presenti.";
export function buildOperationalReadingTask(request: OperationalRequest) {
  assertCurrent(request);
  return {
    system: instructions + pathInstructions,
    prompt: JSON.stringify({
      task: "Lettura operativa con prove proprie, completa e verificabile",
      ...dictionarySource(request),
    }),
    maxTokens: 16384,
    responseFormat: responseFormat(request),
  };
}
export function buildOperationalReviewTask(
  request: OperationalRequest,
  answer: unknown,
) {
  const checked = operationalReviewRequest(request, answer);
  return {
    system:
      instructions +
      pathInstructions +
      " Verifica indipendentemente ciascun fatto contro gli originali, inclusi i null. supported richiede prove proprie complete; contraddizioni concrete restano contradicted e dubbi not_verifiable. La data condivisa conserva project_context e deve riguardare il lotto.",
    prompt: JSON.stringify({
      task: "Revisione semantica della lettura operativa",
      ...dictionarySource(request, checked.answer),
    }),
    maxTokens: 16384,
    responseFormat: responseFormat(request, true),
  };
}
export function explicitOperationalDeadline(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    date(value);
    return value;
  } catch {
    return null;
  }
}
