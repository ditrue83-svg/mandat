import assert from "node:assert/strict";
import {test} from "vitest";
import {buildSourceInterpretationRequest,recordSourceInterpretation,type SourceInterpretationContext} from "../src/lib/source-interpretation";
function fixture(title:string,description:string,role:"execute"|"supply",selected:"s1"|"s2"){
 const passages=[{id:"s1",text:title,rawPath:"/base/title/it"},{id:"s2",text:description,rawPath:"/procurement/orderDescription/it"}].map(p=>({...p,scope:"project_context" as const,role:"service" as const,startUtf16:0,endUtf16:p.text.length,url:"https://example.invalid/invented-action"}));
 const context:SourceInterpretationContext={binding:{target:{kind:"project",publicationId:"invented-action-proof"},source:{original:"invented-only"},fieldsHash:"a".repeat(64),shapeEpochToken:"invented",model:"gpt-6-luna",reasoningEffort:"medium",maxTokens:8192},targetScope:"project_context",coverage:{completeProvidedSource:true,linkedDocumentsRead:false,sourceUtf16:passages.reduce((n,p)=>n+p.text.length,0),fields:0,chunks:1},body:{target:{kind:"project",lot:null},passages,fields:[],classifications:[]},readings:[]};
 const request=buildSourceInterpretationRequest(context),prompt=JSON.parse(request.prompt),literal=prompt.originalLiteralCatalogue[selected][0][0];
 const value:any={evidenceFormat:"source_selections_v21_owned",status:"resolved",targetRef:"s1",summary:title,summaryAdditionalSourceRefs:[],details:[],issues:[],classificationReadingsById:{},contractClauseDetails:Object.fromEntries(request.contractDetailFamilies.map(f=>[f.id,[{kind:"technical_specification",scope:f.scope,sourceRefs:f.sourceRefs,originalText:true}]])),components:[{description,importance:"not_stated",role,evidenceDeclaration:{basis:"selected_action_object_plus_explicit_additional_originals",additionalEvidence:[]},roleEvidence:{state:"identified",scope:"project_context",actionSelection:{literalSelectionId:literal}},meaning:{state:"identified",statement:description,objectSelection:{literalSelectionId:literal},basis:"explicit_text"}}]};
 return {context,request,prompt,value,selected};
}
test("Generic framework title guidance chooses actual commissioned function; own canonical action stays on selected description",()=>{
 const f=fixture("Accordo quadro per eventi","Pianificazione, organizzazione e coordinamento dell'infrastruttura tecnica per eventi.","execute","s2"),before=JSON.stringify(f.context);
 const rule=f.prompt.rules.find((r:string)=>r.startsWith("roleEvidence:"));
 assert(rule.includes("titolo di contratto/settore non bastano"));assert(rule.includes("additionalEvidence non sostituisce actionSelection"));
 const record=recordSourceInterpretation(f.value,f.request,{id:"invented-action-record",at:"2030-01-01T00:00:00Z",model:"gpt-6-luna"});
 assert.deepEqual(record.response.components[0].roleEvidence.sourceRefs,["s2"]);
 assert.equal(record.response.components[0].roleEvidence.actionText,f.context.body.passages[1].text);
 assert.equal(JSON.stringify(f.context),before);
});
test("A title containing a nominal purchased action remains available with its specific role",()=>{
 const f=fixture("Fornitura di quadri per eventi","Fornitura di quadri per eventi.","supply","s1");
 assert(f.prompt.rules.some((r:string)=>r.includes("Un titolo vale se nomina l'azione")));
 const record=recordSourceInterpretation(f.value,f.request,{id:"invented-nominal-title-record",at:"2030-01-01T00:00:00Z",model:"gpt-6-luna"});
 assert.equal(record.response.components[0].role,"supply");assert.deepEqual(record.response.components[0].roleEvidence.sourceRefs,["s1"]);assert.equal(record.response.components[0].roleEvidence.actionText,"Fornitura di quadri per eventi");
});
