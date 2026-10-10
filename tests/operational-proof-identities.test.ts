import {test, expect} from "vitest";
import * as native from "../src/lib/lot-operational-evidence";
import {createFieldBoundProtocol} from "../src/lib/field-bound-protocol.mjs";
function fixture(){
  const context:any={target:{kind:"lot",publicationId:"invented-proof-publication",lotId:"invented-lot"},dependency:{hash:"invented"},projectBarrier:{reason:"not_reviewed"},targetContent:{identity:{detailUrl:"https://example.invalid/proof"},selectedLot:{path:"/lots/1",record:{id:"invented-lot",title:{de:"Invented regional event",it:"Invented regional event"},orderAddress:{countryId:"CH"},repeated:{a:"CH",b:"CH",c:"CH"},options:false,quantity:0,missing:null}},projectSections:{dates:{offerDeadline:"2030-08-17T23:59:00+02:00"}}}};
  const request=native.buildOperationalEvidenceRequest(context),protocol=createFieldBoundProtocol(native,request),task=protocol.readingTask(),payload=JSON.parse(task.prompt);return {context,request,protocol,task,payload};
}
function empty(binding:string){return {binding,country:null,countryEvidence:[],canton:null,cantonEvidence:[],city:null,cityEvidence:[],deadline:{value:null,appliesToTarget:null,dateFieldId:null,submissionFieldIds:[],lotApplicabilityFieldIds:[],otherEvidenceFieldIds:[]},rationale:"Invented structural test only",issues:[]};}
test("proof identities keep their path despite deduplicated strings",()=>{const f=fixture(),decoded=native.decodeOperationalTaskPrompt(f.task.prompt);expect(decoded.source).toEqual(f.request.data);expect(decoded.source.selectedLot).toEqual(f.context.targetContent.selectedLot.record);expect(f.payload).not.toHaveProperty("fieldIdentityCatalog");const country=f.payload.originalProofCatalog.filter((r:any)=>r[2].includes("/orderAddress/countryId")||r[2].includes("/repeated/"));expect(new Set(country.map((r:any)=>r[0])).size).toBe(4);expect(new Set(country.map((r:any)=>r[3][1])).size).toBe(1);});
test("a dictionary key cannot be selected as a proof",()=>{const f=fixture(),a:any=empty(f.protocol.binding),row=f.payload.originalProofCatalog.find((r:any)=>r[2].endsWith("/offerDeadline"));a.deadline.dateFieldId=row[3][1];expect(()=>f.protocol.decodeReading(a)).toThrow("Operational reference reading schema invalid");});
test("title proof stays invalid for a date role",()=>{const f=fixture(),a:any=empty(f.protocol.binding),title=f.payload.originalProofCatalog.find((r:any)=>r[2].endsWith("/title/de"));a.deadline.dateFieldId=title[0];a.deadline.value="2030-08-17T23:59:00+02:00";expect(()=>f.protocol.decodeReading(a)).toThrow("Date role does not reference offerDeadline");});
test("missing text and rebound proof rows reject without reconstructing another original",()=>{const f=fixture(),a=structuredClone(f.payload);delete a.source.strings.text_0;expect(()=>native.decodeOperationalTaskPrompt(JSON.stringify(a))).toThrow("Original text");const b=structuredClone(f.payload);b.originalProofCatalog[0][0]="f999";expect(()=>native.decodeOperationalTaskPrompt(JSON.stringify(b))).toThrow("Original proof identity row invalid");});
test("reading and review instructions match their proof dictionary while legacy context remains lossless",()=>{
  const f=fixture(),raw=empty(f.protocol.binding),answer=f.protocol.decodeReading(raw),review=f.protocol.reviewTask(raw);
  for(const task of [f.task,review]){
    const data=JSON.parse(task.prompt),decoded=native.decodeOperationalTaskPrompt(task.prompt);
    expect(data.source.encoding).toBe("original-proof-dictionary-v2");
    expect(task.system).toContain("['text','text_N']");
    expect(task.system).not.toContain("['s',indice]");
    expect(task.system).not.toContain("tuple [scope,percorso originale,indice stringa]");
    expect(decoded.source).toEqual(f.request.data);
  }
  expect(native.decodeOperationalTaskPrompt(review.prompt).reading).toEqual(answer);
  const legacy=native.buildOperationalReadingTask(f.request);
  expect(JSON.parse(legacy.prompt).source.encoding).toBe("original-dictionary-v1");
  expect(native.decodeOperationalTaskPrompt(legacy.prompt).source).toEqual(f.request.data);
});
