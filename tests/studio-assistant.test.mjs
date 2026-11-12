import test from 'node:test';
import assert from 'node:assert/strict';
import {createDefaultLayout} from '../web/studio-model.js';
import {createTemplate,createProjectEvidence} from '../web/studio-project-model.js';
import {answerProjectQuestion} from '../web/studio-assistant.js';

test('local assistant never infers safety approval from empty checks or a radius',()=>{
  const layout=createDefaultLayout(),projectEvidence=createProjectEvidence(layout);
  for(const safetySettings of [{},{radius:2,source:'example'}]){
    const result=answerProjectQuestion('안전한 배치인가요?',{layout,projectEvidence,safetySettings});
    assert.equal(result.mode,'local_lookup');assert.match(result.answer,/미평가/);assert.doesNotMatch(result.answer,/100%|안전합니다/);
  }
});
test('unmatched run data and unsupported layouts are not advertised as successful execution',()=>{
  const layout=createTemplate('machining-automation'),projectEvidence=createProjectEvidence(layout);
  const support=answerProjectQuestion('아이작 변환 가능한가요?',{layout,projectEvidence});
  assert.match(support.answer,/전송할 수 없는/);
  const report=answerProjectQuestion('보고서의 개선율은?',{layout,projectEvidence,runEvidence:{job_id:'old',job_detail:{job_id:'old',good:999}}});
  assert.match(report.answer,/일치하는 실행 근거/);assert.doesNotMatch(report.answer,/999|증가했습니다/);
});
