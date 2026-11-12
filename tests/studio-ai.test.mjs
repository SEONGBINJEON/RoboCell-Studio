import test from 'node:test';
import assert from 'node:assert/strict';
import {analysisContextKey,normalizeAIResult,matchingAIAnalysis} from '../web/studio-ai.js';
import {buildReviewReport} from '../web/studio-report.js';
import {createDefaultLayout} from '../web/studio-model.js';
const result={mode:'llm',provider:'aws-bedrock',model:'test-model',answer:'<script>alert(1)</script> 추가 확인 필요',citations:[{evidence_id:'layout',field:'factory.width'},{evidence_id:'invented',field:'approve'}],unverified:['설비 사양 필요'],request_id:'test-request'};
test('AI results require actual provider mode and only known evidence IDs',()=>{
  assert.throws(()=>normalizeAIResult({...result,mode:'local'}));assert.throws(()=>normalizeAIResult({...result,answer:''}));
  assert.deepEqual(normalizeAIResult(result).citations,[{evidence_id:'layout',field:'factory.width'}]);
});
test('AI analysis binds the full context and invalidates on changed inputs or evidence',()=>{
  const context={layout:createDefaultLayout(),projectEvidence:undefined,runEvidence:undefined,planningReview:undefined,diagnostics:null};
  const aiAnalysis={context_key:analysisContextKey(context),result,generated_at:'2026-11-12T03:00:00Z'};
  assert.ok(matchingAIAnalysis(context,aiAnalysis));
  const report=buildReviewReport({...context,aiAnalysis});assert.equal(report.summary.aiConnected,true);assert.match(report.html,/&lt;script&gt;/);assert.doesNotMatch(report.html,/<script>/);
  context.layout.assets[0].x+=1;assert.equal(matchingAIAnalysis(context,aiAnalysis),null);assert.equal(buildReviewReport({...context,aiAnalysis}).summary.aiConnected,false);
});
test('canonical context order is stable but data type and array order remain significant',()=>{
  assert.equal(analysisContextKey({b:1,a:2}),analysisContextKey({a:2,b:1}));
  assert.notEqual(analysisContextKey({a:1}),analysisContextKey({a:'1'}));
  assert.notEqual(analysisContextKey({a:[1,2]}),analysisContextKey({a:[2,1]}));
});
