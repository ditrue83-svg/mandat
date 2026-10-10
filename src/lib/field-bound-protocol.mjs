import { createHash } from "node:crypto";
import { z } from "zod";

export class OperationalFieldReferenceError extends Error {}
export const isFieldBoundRejection = (e) =>
  e instanceof OperationalFieldReferenceError;
export const PROTOCOL_VERSION = "operational-field-bound-v6-own-proof-coverage";
const stable = (v) =>
  Array.isArray(v)
    ? `[${v.map(stable).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.entries(v)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`)
          .join(",")}}`
      : (JSON.stringify(v) ?? "null");
const hash = (v) => createHash("sha256").update(stable(v)).digest("hex");
const freeze = (v) => {
  if (v && typeof v === "object") {
    for (const x of Object.values(v)) freeze(x);
    Object.freeze(v);
  }
  return v;
};
const facts = ["country", "canton", "city", "deadline"];
const datePath = (p) => /\/offerDeadline$/.test(p.path);
const submissionPath = (p) =>
  p.scope === "project_context" &&
  /^\/project-info\/offerSpecificNote\/(it|fr|de|en)$/.test(p.path);
const scopePath = (p) =>
  p.scope === "project_context" &&
  /^\/(?:(?:project-info|base)\/participantLotsLimitationNote|project-info\/offerSpecificNote)\/(it|fr|de|en)$/.test(
    p.path,
  );

// Supply the byte-exact native module explicitly. This prototype changes neither
// native validation nor storage. It must only be used in a distinct future phase.
export function createFieldBoundProtocol(native, request) {
  const task = native.buildOperationalReadingTask(request);
  const catalog = native
    .decodeOperationalTaskPrompt(task.prompt)
    .originalProofCatalog.map((p, i) => ({
      fieldId: `f${i}`,
      ...p,
    }));
  if (new Set(catalog.map((p) => p.fieldId)).size !== catalog.length)
    throw Error("Duplicate original field identity");
  const binding = hash({
    version: PROTOCOL_VERSION,
    nativeVersion: request.version,
    inputHash: request.inputHash,
    catalog,
  });
  const snapshot = freeze(JSON.parse(JSON.stringify(catalog)));
  const byId = new Map(snapshot.map((p) => [p.fieldId, p]));
  const ids = snapshot.map((p) => p.fieldId);
  if (!ids.length) throw Error("No original fields");
  const ref = z.enum(ids),
    refs = z.array(ref).max(12);
  const readingSchema = z
    .object({
      binding: z.literal(binding),
      country: z
        .string()
        .regex(/^[A-Z]{2}$/)
        .nullable(),
      countryEvidence: refs,
      canton: z
        .string()
        .regex(/^[A-Z]{2}$/)
        .nullable(),
      cantonEvidence: refs,
      city: z.string().min(1).nullable(),
      cityEvidence: refs,
      deadline: z
        .object({
          value: z.string().nullable(),
          appliesToTarget: z.boolean().nullable(),
          dateFieldId: ref.nullable(),
          submissionFieldIds: refs,
          lotApplicabilityFieldIds: refs,
          otherEvidenceFieldIds: refs,
        })
        .strict(),
      rationale: z.string().min(1),
      issues: z.array(z.string()).max(12),
    })
    .strict();
  const check = z
    .object({
      verdict: z.enum(["supported", "not_verifiable", "contradicted"]),
      evidence: refs,
      rationale: z.string().min(1),
    })
    .strict();
  const reviewSchema = z
    .object({
      binding: z.literal(binding),
      checks: z
        .object(Object.fromEntries(facts.map((k) => [k, check])))
        .strict(),
      issues: z.array(z.string()).max(12),
    })
    .strict();
  function current() {
    // Native assertCurrent detects changed source/request. Rebuild the catalog too.
    const fresh = native.buildOperationalReadingTask(request);
    if (fresh.prompt !== task.prompt)
      throw Error("Original source binding changed");
  }
  function proof(id) {
    const p = byId.get(id);
    if (!p)
      throw new OperationalFieldReferenceError(
        "Unknown original field identity",
      );
    return { scope: p.scope, path: p.path, quote: p.quote };
  }
  function decodeRefs(values) {
    if (new Set(values).size !== values.length)
      throw new OperationalFieldReferenceError("Duplicate evidence reference");
    return values.map(proof);
  }
  function decodeReading(raw) {
    current();
    const parsed = readingSchema.safeParse(raw);
    if (!parsed.success)
      throw new OperationalFieldReferenceError(
        "Operational reference reading schema invalid",
      );
    const a = parsed.data,
      d = a.deadline;
    const dp = d.dateFieldId === null ? null : proof(d.dateFieldId);
    if (dp && !datePath(dp))
      throw new OperationalFieldReferenceError(
        "Date role does not reference offerDeadline",
      );
    if (d.submissionFieldIds.some((id) => !submissionPath(proof(id))))
      throw new OperationalFieldReferenceError(
        "Submission role references wrong original field",
      );
    if (d.lotApplicabilityFieldIds.some((id) => !scopePath(proof(id))))
      throw new OperationalFieldReferenceError(
        "Lot applicability role references wrong original field",
      );
    if (d.value !== null && (!dp || dp.quote !== d.value))
      throw new OperationalFieldReferenceError(
        "Date value lacks exact date identity",
      );
    if (
      d.value !== null &&
      dp?.scope === "project_context" &&
      (!d.submissionFieldIds.length || !d.lotApplicabilityFieldIds.length)
    )
      throw new OperationalFieldReferenceError(
        "Shared date requires explicit submission and lot-applicability selections",
      );
    // Same field can have two declared roles (explicit all-lots instruction).
    // Role overlap is deterministic union, never dropping invalid evidence.
    const ids = [
      ...(d.dateFieldId === null ? [] : [d.dateFieldId]),
      ...d.submissionFieldIds,
      ...d.lotApplicabilityFieldIds,
      ...d.otherEvidenceFieldIds,
    ];
    for (const list of [
      d.submissionFieldIds,
      d.lotApplicabilityFieldIds,
      d.otherEvidenceFieldIds,
    ])
      decodeRefs(list);
    const answer = {
      country: a.country,
      countryEvidence: decodeRefs(a.countryEvidence),
      canton: a.canton,
      cantonEvidence: decodeRefs(a.cantonEvidence),
      city: a.city,
      cityEvidence: decodeRefs(a.cityEvidence),
      deadline: d.value,
      deadlineAppliesToTarget: d.appliesToTarget,
      deadlineEvidence: [...new Set(ids)].map(proof),
      rationale: a.rationale,
      issues: a.issues,
    };
    // Exact originals, scope, date, conflict and applicability grammar stay native.
    return native.operationalReviewRequest(request, answer).answer;
  }
  function decodeReview(raw) {
    current();
    const parsed = reviewSchema.safeParse(raw);
    if (!parsed.success)
      throw new OperationalFieldReferenceError(
        "Operational reference review schema invalid",
      );
    const r = parsed.data;
    return {
      checks: Object.fromEntries(
        facts.map((k) => [
          k,
          { ...r.checks[k], evidence: decodeRefs(r.checks[k].evidence) },
        ]),
      ),
      issues: r.issues,
    };
  }
  function format(schema, name) {
    const s = z.toJSONSchema(schema);
    delete s.$schema;
    const dedup = (node) => {
      if (!node || typeof node !== "object") return node;
      if (Array.isArray(node.enum) && stable(node.enum) === stable(ids))
        return { $ref: "#/$defs/originalFieldIdentity" };
      if (Array.isArray(node)) return node.map(dedup);
      return Object.fromEntries(
        Object.entries(node).map(([k, v]) => [k, dedup(v)]),
      );
    };
    const bounded = dedup(s);
    bounded.$defs = { originalFieldIdentity: { type: "string", enum: ids } };
    return {
      type: "json_schema",
      json_schema: { name, strict: true, schema: bounded },
    };
  }
  // Keep the complete native dictionary source; references add path identities,
  // not summaries. Quotes are recovered from that bound source, never supplied
  // or corrected after a provider response. Compact IDs are catalog-local; the required binding makes their identity request-specific.
  // Each originalProofCatalog row directly names its selectable proofId and
  // its separate text reference, without copying or summarizing original quotes.
  function payload(nativeTask) {
    const data = JSON.parse(nativeTask.prompt), {strings, ...source} = data.source;
    // Text keys and selectable proof identities are different domains. Never
    // derive a proof identity from a text key or its numeric suffix.
    const retag = node => {
      if (!Array.isArray(node)) return node;
      if (node[0] === "s") return ["text", `text_${node[1]}`];
      if (node[0] === "a") return ["a", node[1].map(retag)];
      if (node[0] === "o") return ["o", node[1].map(([key,value])=>[key,retag(value)])];
      return node;
    };
    return {
      ...data,
      source: {...source, encoding:"original-proof-dictionary-v2",
        selectedLot:retag(source.selectedLot),projectSections:retag(source.projectSections),
        strings:Object.fromEntries(strings.map((value,index)=>[`text_${index}`,value]))},
      originalProofCatalog:data.originalProofCatalog.map(([scope,path,index],i)=>
        [snapshot[i].fieldId,scope,path,["text",`text_${index}`]]),
      ...(data.reading ? {reading:retag(data.reading)} : {}),
      protocolVersion: PROTOCOL_VERSION,
      binding,
      referenceDomains:{proofRow:["proofId","scope","path","textReference"],
        selectable:"Only proofId fN from its own originalProofCatalog row",
        textReference:"text_N identifies a string in source.strings, never a proof. Numeric suffixes and row positions are not interchangeable."},
    };
  }
  // Provider context is retagged to v2; keep native v1 task decoding intact.
  function providerContextSystem(system) {
    const oldText = "['s',indice] è la stringa originale INTERA a quell'indice";
    const oldProof = "originalProofCatalog contiene tuple [scope,percorso originale,indice stringa]: cita il valore originale INTERO del dizionario, mai indice o codice.";
    if (!system.includes(oldText) || !system.includes(oldProof))
      throw Error("Operational provider context instructions stale");
    return system.replace(oldText, "['text','text_N'] identifica la stringa originale INTERA con quella chiave")
      .replace(oldProof, "originalProofCatalog contiene righe [proofId,scope,percorso originale,['text','text_N']]: seleziona soltanto proofId dalla propria riga, mai text_N o il suo suffisso.");
  }
  function readingTask() {
    current();
    return {
      system:
        providerContextSystem(task.system) +
        " Protocollo distinto: seleziona soltanto proofId fN dalla propria riga originalProofCatalog [proofId,scope,path,textReference]; text_N identifica una stringa e NON è una prova: non convertirne il suffisso in fN; non emettere percorso o citazione. Per deadline: dateFieldId richiede /offerDeadline; submissionFieldIds richiede project_context /project-info/offerSpecificNote/{it,fr,de,en}; lotApplicabilityFieldIds richiede project_context /{base,project-info}/participantLotsLimitationNote/{it,fr,de,en} oppure /project-info/offerSpecificNote/{it,fr,de,en}. Sono vincoli di ruolo, non attestazioni automatiche. Le note partialOffersNote del lotto e correction/remarks possono essere solo otherEvidenceFieldIds: non sostituiscono prove di presentazione o applicabilità. I controlli nativi verificano identità, percorsi, ambito e conflitti codificati; la revisione semantica obbligatoria valuta le istruzioni e le contraddizioni testuali. Se non dimostrabile, value null e motivazione.",
      prompt: JSON.stringify(payload(task)),
      maxTokens: task.maxTokens,
      responseFormat: format(readingSchema, "operational_field_bound_reading"),
    };
  }
  function reviewTask(raw) {
    const answer = decodeReading(raw),
      t = native.buildOperationalReviewTask(request, answer);
    // Resolve every own proof by its complete original identity, never by quote
    // alone. This list exposes the existing coverage contract; it supplies no
    // review verdict or response evidence and decodeReview remains unchanged.
    const reviewProofCoverage = Object.fromEntries(facts.map((key) => [key, {
      ownProofIds: answer[`${key}Evidence`].map((proof) => {
        const row = snapshot.find((p) =>
          p.scope === proof.scope && p.path === proof.path && p.quote === proof.quote);
        if (!row) throw Error("Operational review own proof identity absent");
        return row.fieldId;
      }),
      completeCoverageRequired: answer[key] !== null,
    }]));
    return {
      system:
        providerContextSystem(t.system) +
        " Seleziona soltanto proofId fN dalla propria riga del catalogo corrente; text_N non è una prova e non può diventare fN; verifica indipendentemente ogni prova della lettura. reviewProofCoverage espone per ciascun fatto le identità proprie già citate: non è una verifica. Per un fatto non-null, supported richiede tutte queste identità in checks[fatto].evidence, ciascuna verificata indipendentemente; testi uguali con scope o path diversi restano prove distinte e una non sostituisce l’altra. Se una prova non è verificabile o contraddice il fatto, conserva not_verifiable o contradicted e la motivazione, senza aggiungere prove per ottenere supported. Un fatto null non richiede supported né citazioni inventate; verifica l’assenza dagli originali. Il decoder non completa evidence mancanti.",
      prompt: JSON.stringify({...payload(t), reviewProofCoverage}),
      maxTokens: t.maxTokens,
      responseFormat: format(reviewSchema, "operational_field_bound_review"),
    };
  }
  function record(rawReading, rawReview, metadata) {
    return native.recordOperationalEvidence(
      decodeReading(rawReading),
      decodeReview(rawReview),
      request,
      metadata,
    );
  }
  return Object.freeze({
    version: PROTOCOL_VERSION,
    binding,
    catalog: snapshot,
    readingSchema,
    reviewSchema,
    readingTask,
    reviewTask,
    decodeReading,
    decodeReview,
    record,
  });
}
