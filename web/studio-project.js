import { getFactoryTemplates, createTemplate, EVIDENCE_FIELDS, EVIDENCE_SOURCES, createProjectEvidence, summarizeProjectEvidence, updateProjectEvidenceField } from './studio-project-model.js';
import { buildReviewReport } from './studio-report.js';
import { answerProjectQuestion } from './studio-assistant.js';
import { analyzePlanningSafety, normalizeSafetySettings } from './studio-safety.js';
import { PUBLIC_FACTORY_REFERENCES, SAFETY_REFERENCES } from './studio-references.js';
import { getIsaacCompatibility } from './studio-isaac.js';
import { renderLayoutPlanSvg } from './studio-plan.js';
import { getAIStatus, askProjectAI, generateAIReport, analysisContextKey } from './studio-ai.js';
import { mountDiagnostics } from './studio-diagnostics.js';

const node=(tag,text,className)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;};
const button=(text,action)=>{const el=node('button',text);el.type='button';el.addEventListener('click',action);return el;};
const link=(text,url)=>{const el=node('a',text);el.href=url;el.target='_blank';el.rel='noopener noreferrer';return el;};
const download=(name,body,type)=>{const url=URL.createObjectURL(new Blob([body],{type})),a=node('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);};
const STORE='robocell-project-context-v1';
const TABS=[['examples','공장 예시'],['diagnostics','설비 진단'],['evidence','입력 근거'],['safety','안전 검토'],['assistant','AI 분석'],['report','보고서'],['demo','시연 순서']];

export function mountProjectDesk({getLayout,onLoadLayout,getRunEvidence,getScene,openLive,openEditor,onSelectAsset,notify}) {
  let evidence=createProjectEvidence(getLayout()),safety={radius:null,source:'assumption',reference:''},showEnvelopes=false,documents=[],messages=[],pane='examples',reportUrl=null;
  let storageBlocked=false;
  let aiStatus=null,aiAnalysis=null,aiBusy=false,reportBusy=false,diagnosticsApi=null,reviewRunSnapshot=null;
  const statusPromise=getAIStatus().then(value=>{aiStatus=value;return value;}).catch(()=>{aiStatus={available:false,mode:'unavailable'};return aiStatus;});
  try{const raw=localStorage.getItem(STORE);if(raw){const saved=JSON.parse(raw);if(saved.schema_version!=='robocell-project-context/v1')throw new Error('unknown');evidence=createProjectEvidence(getLayout(),saved.evidence);safety=normalizeSafetySettings(saved.safety);documents=Array.isArray(saved.documents)?saved.documents.slice(0,12):[];if(EVIDENCE_FIELDS.some(field=>saved.evidence?.fields?.[field.id]?.status==='confirmed'&&evidence.fields[field.id].status!=='confirmed'))throw new Error('damaged confirmation');}}
  catch{storageBlocked=true;notify('프로젝트 근거 기록을 읽지 못했습니다. 원본은 보존하며 새 기록은 이번 화면에서만 사용합니다.');}
  const save=()=>{if(storageBlocked)return;try{localStorage.setItem(STORE,JSON.stringify({schema_version:'robocell-project-context/v1',evidence,safety,documents}));}catch{storageBlocked=true;notify('근거 기록 저장 공간이 부족합니다. 보고서를 내려받아 보관하세요.');}};
  function resetForLayout(next,options={}){
    // A new file/template/draft is a new evidence scope, even when dimensions
    // happen to match. Preserve meaningful prior records before replacing them.
    const meaningful=documents.length||safety.radius!==null||Object.values(evidence.fields).some(field=>field.reference||field.note||field.status==='confirmed');
    if(meaningful&&!storageBlocked){try{const archive={schema_version:'robocell-project-context/v1',archived_at:new Date().toISOString(),evidence,safety,documents};const archiveId=globalThis.crypto?.randomUUID?.()||`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;localStorage.setItem(`${STORE}-archive-${archiveId}`,JSON.stringify(archive));}catch{storageBlocked=true;notify('이전 근거를 보존할 저장 공간이 부족해 새 근거의 자동 저장을 보류합니다.');}}
    evidence=createProjectEvidence(next,options);safety={radius:null,source:'assumption',reference:''};showEnvelopes=false;documents=[];messages=[];aiAnalysis=null;reviewRunSnapshot=null;save();refresh();
  }
  const tools=node('div',undefined,'project-tools');tools.id='project-tools';tools.setAttribute('aria-label','설계 검토 도구');
  document.querySelector('.workspace-tabs').after(tools);
  const commandbar=node('div',undefined,'workspace-commandbar'),workspaceTabs=document.querySelector('.workspace-tabs');
  workspaceTabs.before(commandbar);commandbar.append(workspaceTabs,tools);
  const dialog=node('dialog',undefined,'project-dock');dialog.id='project-dock';dialog.setAttribute('aria-labelledby','project-dock-title');
  const heading=node('div',undefined,'dialog-heading'),title=node('h2','프로젝트 검토');title.id='project-dock-title';
  const close=button('×',()=>dialog.close());close.setAttribute('aria-label','프로젝트 검토 닫기');heading.append(title,close);
  const nav=node('nav',undefined,'dock-tabs');nav.setAttribute('aria-label','프로젝트 검토 항목');
  const content=node('div',undefined,'dock-body');content.id='project-dock-content';dialog.append(heading,nav,content);document.body.append(dialog);
  const diagnosticsContainer=node('div',undefined,'diagnostics-host');
  const toolButtons=new Map(),navButtons=new Map();
  for(const [id,label] of TABS){const tool=button(label,()=>open(id));tool.dataset.projectPanel=id;tools.append(tool);toolButtons.set(id,tool);const tab=button(label,()=>{pane=id;renderPane();});tab.setAttribute('aria-controls',content.id);nav.append(tab);navButtons.set(id,tab);}
  const context=()=>({layout:getLayout(),projectEvidence:evidence,runEvidence:getRunEvidence(),safetySettings:safety});
  // Review a captured server observation; background polling must not invalidate
  // an analysis merely by changing its export/fetch timestamp. Opening the desk
  // again or explicitly refreshing the report captures the latest observation.
  const aiContext=()=>({layout:getLayout(),projectEvidence:evidence,runEvidence:reviewRunSnapshot,planningReview:analyzePlanningSafety(getLayout(),safety),diagnostics:diagnosticsApi?.getEvidence()??null});
  const currentReport=()=>buildReviewReport({...aiContext(),aiAnalysis});
  function paragraph(text,style='dock-note'){const p=node('p',text,style);content.append(p);return p;}
  function section(text){const h=node('h3',text);content.append(h);return h;}
  function closeThen(action){dialog.close();action();}
  function refresh(){const summary=summarizeProjectEvidence(getLayout(),evidence);toolButtons.get('evidence').textContent=`입력 근거 ${summary.confirmedCount}/${summary.totalCount}`;getScene()?.setPlanningEnvelopes(showEnvelopes?analyzePlanningSafety(getLayout(),safety).envelopes:[]);diagnosticsApi?.refreshLayout();}
  function open(id='examples'){reviewRunSnapshot=getRunEvidence();pane=TABS.some(t=>t[0]===id)?id:'examples';renderPane();if(!dialog.open)dialog.showModal();}
  function renderPane(){
    title.textContent=TABS.find(t=>t[0]===pane)[1];navButtons.forEach((b,id)=>b.setAttribute('aria-pressed',String(id===pane)));content.replaceChildren();
    if(reportUrl){URL.revokeObjectURL(reportUrl);reportUrl=null;}
    ({examples:renderExamples,diagnostics:renderDiagnostics,evidence:renderEvidence,safety:renderSafety,assistant:renderAssistant,report:renderReport,demo:renderDemo})[pane]();
  }
  function renderDiagnostics(){
    content.append(diagnosticsContainer);
    if(!diagnosticsApi)diagnosticsApi=mountDiagnostics(diagnosticsContainer,{getLayout,getRunEvidence,notify,
      onSelectAsset:id=>closeThen(()=>{openEditor();onSelectAsset?.(id);}),
      askAI:async()=>{const source=aiContext(),key=analysisContextKey(source);const result=await askProjectAI('이 설비 진단 근거의 출처를 먼저 밝히고, 주요 이상징후·가능한 원인 가설·현장에서 추가 확인할 항목을 구분해 주세요. 정상 판정이나 안전 승인을 하지 마세요.',source);if(key!==analysisContextKey(aiContext()))throw new Error('분석 중 근거가 변경되어 응답을 제외했습니다.');return result;}
    });else diagnosticsApi.refreshLayout();
  }
  function renderExamples(){
    paragraph('네 가지 배치 예시입니다. 공장 치수·설비 위치·작업시간은 시연용 가정이며 특정 현장의 실측 자료가 아닙니다. 불러온 뒤 실행 취소로 현재 배치로 돌아갈 수 있습니다.');
    const list=node('div',undefined,'scenario-list');
    for(const template of getFactoryTemplates()){
      const card=node('article'),h=node('h3',template.name),p=node('p',template.description),meta=node('p',`${template.width} × ${template.depth} m · 설비 ${template.equipmentCount}개 · 합성 예시`,'dock-note');
      const compatible=!getIsaacCompatibility(createTemplate(template.id)).errors.length;
      const tag=node('p',compatible?'현재 실행기 입력 지원':'3D 편집·저장 지원 / 개별 설비 실행 연동 필요','scenario-status');
      const preview=node('div',undefined,'scenario-plan');preview.innerHTML=renderLayoutPlanSvg(createTemplate(template.id),{compact:true});
      card.append(preview,h,p,meta,tag,button('배치 불러오기',()=>{
        const next=createTemplate(template.id);onLoadLayout(next,{source:'example',templateId:template.id});save();refresh();dialog.close();openEditor();notify(`${template.name} 예시를 불러왔습니다. 치수·작업시간은 가정값입니다.`);
      }));list.append(card);
    }content.append(list);section('공개 공장 자료');paragraph('공식 자료로 확인한 공정과, 아직 확보하지 못한 실측값을 구분합니다. 아래 기업의 자료가 현재 배치의 정확성을 보증하지는 않습니다.');
    for(const item of PUBLIC_FACTORY_REFERENCES){const article=node('article',undefined,'reference-entry');article.append(node('h4',item.name),node('p',item.focus),node('p',item.facts),node('p',item.usable),node('p',item.missing,'dock-note'),link(`${item.source} · ${item.date}`,item.url));content.append(article);}
  }
  function renderEvidence(){
    const summary=summarizeProjectEvidence(getLayout(),evidence);
    paragraph(`사용자 확인 ${summary.confirmedCount}/${summary.totalCount}개. 이 수치는 자료 정리 상태이며 정확도·안전율·인증 점수가 아닙니다.`,'dock-status');
    const form=node('form');
    for(const field of EVIDENCE_FIELDS){
      const current=evidence.fields[field.id],state=summary.fields.find(f=>f.id===field.id),row=node('fieldset',undefined,'evidence-field');row.dataset.evidenceField=field.id;
      row.append(node('legend',field.label),node('p',field.description,'dock-note'));
      const srcLabel=node('label','자료 구분'),select=node('select');select.name=`${field.id}-source`;for(const [v,label]of Object.entries(EVIDENCE_SOURCES)){const option=node('option',label);option.value=v;select.append(option);}select.value=current.source;srcLabel.append(select);
      const refLabel=node('label','자료명·URL·측정일'),reference=node('input');reference.name=`${field.id}-reference`;reference.value=current.reference;reference.maxLength=500;refLabel.append(reference);
      const noteLabel=node('label',field.id==='materialFlow'?'공정 순서·운반 방식':'확인 메모'),note=node('textarea');note.name=`${field.id}-note`;note.rows=2;note.maxLength=2000;note.value=field.id==='materialFlow'?current.value:current.note;noteLabel.append(note);
      const checkLabel=node('label',undefined,'evidence-check'),confirmed=node('input');confirmed.type='checkbox';confirmed.name=`${field.id}-confirmed`;confirmed.checked=state.confirmed;checkLabel.append(confirmed,node('span','현재 입력값을 해당 자료와 대조했습니다'));
      const status=node('p',state.stale?'입력값 변경 · 다시 확인 필요':state.confirmed?'사용자 확인됨':'미확인','dock-note');
      row.append(srcLabel,refLabel,noteLabel,checkLabel,status);form.append(row);
    }
    const submit=node('button','근거 기록 저장');submit.type='submit';form.append(submit);
    form.addEventListener('submit',event=>{event.preventDefault();try{let next=evidence;for(const field of EVIDENCE_FIELDS){const fields=form.elements;next=updateProjectEvidenceField(getLayout(),next,field.id,{source:fields[`${field.id}-source`].value,reference:fields[`${field.id}-reference`].value,note:fields[`${field.id}-note`].value,...(field.id==='materialFlow'?{value:fields[`${field.id}-note`].value}:{}),status:fields[`${field.id}-confirmed`].checked?'confirmed':'unverified'});}evidence=next;save();refresh();renderPane();notify('입력 근거를 저장했습니다. 값이 바뀌면 재확인 상태로 표시합니다.');}catch(error){notify(error.message);}});content.append(form);
    section('자료 등록');paragraph('TXT·CSV·JSON 문서를 이 브라우저에서 읽고 파일명·SHA256을 기록합니다. 현재 문서를 자동 해석하거나 외부 AI로 전송하지 않습니다.');
    const file=node('input');file.type='file';file.accept='.txt,.csv,.json';file.setAttribute('aria-label','입력 근거 자료 등록');
    const preview=node('pre',undefined,'source-preview');
    file.addEventListener('change',async()=>{const input=file.files[0];if(!input)return;try{if(input.size>1_000_000)throw new Error('자료는 1MB 이하 TXT·CSV·JSON으로 등록하세요.');const bytes=await input.arrayBuffer();const hash=globalThis.crypto?.subtle?[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join(''):null;documents=[{name:input.name.slice(0,180),sha256:hash,size:input.size,registered_at:new Date().toISOString()},...documents].slice(0,12);save();preview.textContent=new TextDecoder().decode(bytes).slice(0,6000);filesList();notify(hash?'파일 식별 정보를 기록했습니다. 확인할 항목의 자료명에 파일명을 입력하세요.':'자료를 등록했습니다. 현재 접속 환경에서는 SHA256 계산을 지원하지 않습니다.');}catch(error){notify(error.message);}finally{file.value='';}});
    const docs=node('ul',undefined,'source-files');function filesList(){docs.replaceChildren(...documents.map(doc=>node('li',`${String(doc.name)} · ${doc.sha256?String(doc.sha256).slice(0,16)+'…':'SHA256 미계산'} · ${String(doc.size)} bytes`)));}filesList();content.append(file,docs,preview);
    const archiveSection=node('details',undefined,'evidence-archives');archiveSection.append(node('summary','이전 배치의 근거 기록'));
    try{
      const entries=[];for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(!key?.startsWith(`${STORE}-archive-`))continue;const raw=localStorage.getItem(key);try{const archived=JSON.parse(raw);entries.push({raw,date:archived.archived_at});}catch{/* Preserve unreadable records in storage. */}}
      entries.sort((a,b)=>String(b.date).localeCompare(String(a.date)));
      if(!entries.length)archiveSection.append(node('p','보관된 이전 배치 기록이 없습니다.','dock-note'));
      for(const entry of entries.slice(0,30)){const row=node('p');row.append(node('span',`${entry.date||'시각 미상'} `),button('근거 JSON 저장',()=>download('RoboCell_이전배치근거.json',entry.raw,'application/json')));archiveSection.append(row);}
    }catch{archiveSection.append(node('p','이 브라우저에서 이전 기록을 읽을 수 없습니다.','dock-note'));}content.append(archiveSection);
  }
  function renderSafety(){
    paragraph('입력 반경과 작업자·통로의 평면 겹침을 확인합니다. 산업용 로봇의 안전 평가에는 실제 로봇·공구 사양, 정지 특성, 방호장치와 위험성 평가가 필요합니다.','dock-status');
    const form=node('form',undefined,'safety-form'),radiusLabel=node('label','검토 반경 (m · 직접 입력)'),radius=node('input');radius.type='number';radius.min='.1';radius.max='20';radius.step='.1';radius.value=safety.radius??'';radius.name='planning-radius';radius.id='planning-radius';radiusLabel.append(radius);
    const srcLabel=node('label','반경 출처'),src=node('select');src.name='planning-source';for(const [v,label]of Object.entries(EVIDENCE_SOURCES)){const option=node('option',label);option.value=v;src.append(option);}src.value=safety.source;srcLabel.append(src);
    const refLabel=node('label','모델·공구 사양 또는 가정의 근거'),ref=node('input');ref.name='planning-reference';ref.maxLength=500;ref.value=safety.reference;refLabel.append(ref);
    const viewLabel=node('label',undefined,'evidence-check'),visible=node('input');visible.type='checkbox';visible.checked=showEnvelopes;viewLabel.append(visible,node('span','3D 화면에 검토 반경 표시'));
    const apply=node('button','검토 반경 적용');apply.type='submit';form.append(radiusLabel,srcLabel,refLabel,viewLabel,apply,button('2m 예시로 보기',()=>{radius.value='2';src.value='example';ref.value='시연용 2m 가정 · 제조사 도달거리 아님';visible.checked=true;form.requestSubmit();}));
    form.addEventListener('submit',event=>{event.preventDefault();try{safety=normalizeSafetySettings({radius:radius.value,source:src.value,reference:ref.value});showEnvelopes=visible.checked&&safety.radius!==null;save();refresh();renderPane();notify('검토 반경을 적용했습니다. 실제 도달거리나 안전거리 판정이 아닙니다.');}catch(error){notify(error.message);}});content.append(form);
    const review=analyzePlanningSafety(getLayout(),safety);section('현재 배치의 검토 항목');
    const list=node('ul');for(const issue of review.issues)list.append(node('li',issue));if(!review.issues.length)list.append(node('li','입력 반경과 지정 구역의 평면 겹침은 없습니다. 안전 검증 상태는 미평가입니다.'));content.append(list);
    section('검증에 필요한 자료');const needs=node('ul');['로봇 모델·공구·파지물의 실제 최대 동작 범위','작업자 진입·유지보수 동선과 위험 발생 시나리오','펜스·출입문 인터록·감지장치의 위치 및 기능','보호정지 시간·접근 속도·재시작 절차의 검증','동일 조건에서의 충돌·근접 이벤트 로그와 전문가 검토'].forEach(t=>needs.append(node('li',t)));content.append(needs);paragraph(review.note);for(const source of SAFETY_REFERENCES)content.append(link(source.label,source.url),node('br'));
    content.append(button('편집 화면에서 보기',()=>closeThen(openEditor)));
  }
  function renderAssistant(){
    const status=paragraph('AI 연결 상태 확인 중…','dock-status');
    const setStatus=()=>{status.textContent=aiStatus?.available?'AWS Bedrock 연결 · 실제 생성형 AI. 질문 시 현재 배치·검토 요약을 전송합니다. 원본 문서와 인증 정보는 전송하지 않습니다.':'AI 서비스 미연결 · 로컬 근거 조회를 사용할 수 있습니다.';};
    statusPromise.then(setStatus);if(aiStatus)setStatus();
    const modeLabel=node('label','응답 방식'),mode=node('select');for(const [value,text]of [['ai','AWS Bedrock AI 분석'],['local','로컬 근거 조회']]){const option=node('option',text);option.value=value;mode.append(option);}mode.value=aiStatus?.available?'ai':'local';statusPromise.then(()=>{if(aiStatus?.available&&!mode.dataset.changed)mode.value='ai';});mode.addEventListener('change',()=>{mode.dataset.changed='true';});modeLabel.append(mode);content.append(modeLabel);
    const log=node('div',undefined,'assistant-messages');log.setAttribute('role','log');log.setAttribute('aria-live','polite');
    const display=()=>{log.replaceChildren(...messages.map(message=>{const item=node('article');item.dataset.role=message.role;item.append(node('strong',message.role==='user'?'질문':message.mode==='llm'?'AWS Bedrock AI':'로컬 근거 조회'),node('p',message.text));if(message.sources?.length)item.append(node('small',`근거: ${message.sources.join(' / ')}`));if(message.model)item.append(node('small',`모델 ${message.model} · 요청 ${message.request_id}`));return item;}));};display();content.append(log);
    const form=node('form',undefined,'assistant-form'),query=node('textarea');query.rows=2;query.maxLength=2000;query.placeholder='예: 이 배치를 Isaac Sim에서 실행할 수 있나요?';query.setAttribute('aria-label','설계 도우미 질문');const submit=node('button','질문하기');submit.type='submit';form.append(query,submit);
    const ask=async text=>{const input=text.trim();if(!input||aiBusy)return;aiBusy=true;submit.disabled=true;submit.textContent='분석 중…';const source=aiContext(),key=analysisContextKey(source);messages.push({role:'user',text:input});display();query.value='';try{const result=mode.value==='ai'?await askProjectAI(input,source):answerProjectQuestion(input,context());if(key!==analysisContextKey(aiContext()))throw new Error('분석 중 입력 또는 실행 근거가 변경되어 이전 답변을 제외했습니다. 다시 질문해 주세요.');messages.push({role:'assistant',text:result.answer,mode:result.mode,model:result.model,request_id:result.request_id,sources:result.citations?.map(item=>`${item.evidence_id}.${item.field}`)||result.sources});messages=messages.slice(-20);display();log.scrollTop=log.scrollHeight;}catch(error){notify(error.message);status.textContent=error.message;}finally{aiBusy=false;submit.disabled=false;submit.textContent='질문하기';}};form.addEventListener('submit',event=>{event.preventDefault();ask(query.value);});content.append(form);
    const prompts=node('div',undefined,'assistant-prompts');['이 설비 배치의 검토 우선순위를 정리해 주세요.','어떤 이상징후를 먼저 확인해야 하나요?','안전 검토에 무엇이 필요한가요?','실행 결과와 아직 검증하지 못한 항목을 구분해 주세요.'].forEach(text=>prompts.append(button(text,()=>ask(text))));content.append(prompts);
  }
  function renderReport(){
    const report=currentReport();const status=paragraph(report.aiAnalysis?'현재 입력과 연결된 AWS Bedrock AI 의견이 포함되어 있습니다. 입력이 바뀌면 이전 AI 의견은 제외됩니다.':'현재 입력·출처·기하 검사·실행 근거를 정리했습니다. AI 의견은 아래 버튼으로 생성할 수 있습니다.','dock-status');
    const generate=button(reportBusy?'AI 보고서 생성 중…':'AI 검토 의견 생성',async()=>{if(reportBusy)return;reportBusy=true;generate.disabled=true;generate.textContent='AWS Bedrock 분석 중…';const input=aiContext();try{const result=await generateAIReport(input);if(result.context_key!==analysisContextKey(aiContext()))throw new Error('분석 중 입력이 바뀌었습니다. 현재 입력으로 다시 생성하세요.');aiAnalysis=result;reportBusy=false;notify('현재 근거에 연결된 AI 검토 의견을 보고서에 추가했습니다.');if(pane==='report')renderPane();}catch(error){status.textContent=error.message;notify(error.message);}finally{reportBusy=false;generate.disabled=false;generate.textContent='AI 검토 의견 생성';}});generate.disabled=reportBusy;content.append(generate);paragraph('AI 요청 시 현재 배치·검토 요약을 AWS Bedrock에 전송합니다. 결과는 검토 의견이며 설비 상태·안전 인증을 보증하지 않습니다.');
    const actions=node('div',undefined,'report-actions');actions.append(button('HTML 보고서 저장',()=>download('RoboCell_배치검토보고서.html',currentReport().html,'text/html;charset=utf-8')),button('텍스트 저장',()=>download('RoboCell_배치검토보고서.txt',currentReport().text,'text/plain;charset=utf-8')),button('근거 묶음 JSON',()=>download('RoboCell_검토근거.json',JSON.stringify({schema_version:'robocell-review-bundle/v1',layout:getLayout(),projectEvidence:evidence,planningReview:analyzePlanningSafety(getLayout(),safety),documents,runEvidence:reviewRunSnapshot,diagnostics:diagnosticsApi?.getEvidence()??null,aiAnalysis:currentReport().aiAnalysis},null,2),'application/json')),button('보고서 새로고침',()=>{reviewRunSnapshot=getRunEvidence();diagnosticsApi?.refreshRunEvidence();renderPane();}));content.append(actions);
    const frame=node('iframe',undefined,'report-sheet');frame.title='배치 검토 보고서 미리보기';frame.setAttribute('sandbox','');frame.srcdoc=report.html;content.append(frame);paragraph('HTML 파일을 브라우저에서 열어 인쇄 메뉴로 PDF로 저장할 수 있습니다.');
  }
  function renderDemo(){
    paragraph('시연 권장 길이 4분. 준비 장면은 사전 구성 자료로 표시하고, 이번 배치의 실행 결과는 요청 당시 배치와 작업 번호로 연결합니다.','dock-status');
    const steps=[
      ['0:00–0:50','배치 설계','공장 치수와 설비를 한 번 변경하고, 입력 근거·검토 반경을 설명합니다.',()=>closeThen(openEditor),'편집 화면'],
      ['0:50–1:10','실제 실행 요청','현재 실행기 지원 여부를 확인하고 배치를 확정합니다. 서버의 실제 상태를 보여줍니다.',()=>closeThen(()=>openLive('live')),'실행 화면'],
      ['1:10–2:30','사전 구성 사례 설명','대기 중에는 사전 실행 자료임을 밝히고 공정·작업자 동선·위험 구역을 설명합니다. 현재 등록 영상은 과거 로봇 셀 실행 자료입니다.',()=>closeThen(()=>openLive('recorded')),'사전 실행 영상'],
      ['2:30–3:25','이번 배치 결과 확인','이번 작업 번호, 적용된 치수·위치, 실제 영상·정지·재생을 확인합니다. 아직 준비 중이면 그대로 표시합니다.',()=>closeThen(()=>openLive('live')),'현재 실행 확인'],
      ['3:25–4:00','근거와 보고서','확인한 사실, 검출된 문제, 미검증 항목을 한 화면으로 정리합니다.',()=>{pane='report';renderPane();},'보고서'],
    ];const list=node('div',undefined,'demo-steps');for(const [time,name,description,action,label]of steps){const item=node('article');item.append(node('time',time),node('h3',name),node('p',description),button(label,action));list.append(item);}content.append(list);
    section('실행 전에 확인');const status=node('ul'),compatible=getIsaacCompatibility(getLayout());status.append(node('li',compatible.errors.length?`이번 배치 실행 제한: ${compatible.errors.join(' / ')}`:'현재 배치는 기존 실행기 입력 조건에 맞습니다.'));const report=currentReport();status.append(node('li',report.run.included?`선택된 실행 ${report.run.jobId}: 현재 배치와 요청 사본 일치`:'선택된 실행과 현재 배치의 일치 근거가 없거나 배치가 변경되었습니다.'));status.append(node('li','사전 생성 환경을 불러오는 경우 생성 대기 시간을 꾸미지 않고 준비된 환경임을 표시합니다.'));content.append(status);
  }
  dialog.addEventListener('close',()=>{if(reportUrl){URL.revokeObjectURL(reportUrl);reportUrl=null;}});
  refresh();return {open,refresh,resetForLayout,getEvidence:()=>structuredClone(evidence),getPlanningReview:()=>analyzePlanningSafety(getLayout(),safety)};
}
