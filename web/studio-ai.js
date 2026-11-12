/** Same-origin, explicit-action AI client. No credentials or automatic uploads. */
const IDS = new Set(['layout','layout_metrics','input_evidence','run_evidence','planning_review','diagnostics']);
const canonical = value => {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
};
export const analysisContextKey = context => JSON.stringify(canonical(context));
export function normalizeAIResult(raw) {
  if (!raw || raw.mode !== 'llm' || raw.provider !== 'aws-bedrock' || typeof raw.answer !== 'string' || !raw.answer.trim()) throw new Error('AI가 유효한 분석 응답을 반환하지 않았습니다.');
  return {mode:'llm',provider:'aws-bedrock',model:String(raw.model||'미수신').slice(0,160),answer:raw.answer.trim().slice(0,16000),
    citations:Array.isArray(raw.citations)?raw.citations.filter(item=>item && IDS.has(item.evidence_id) && typeof item.field==='string').slice(0,30).map(item=>({evidence_id:item.evidence_id,field:item.field.slice(0,200)})):[],
    unverified:Array.isArray(raw.unverified)?raw.unverified.filter(item=>typeof item==='string').slice(0,20).map(item=>item.slice(0,500)):[],
    request_id:String(raw.request_id||'').slice(0,160),usage:raw.usage&&typeof raw.usage==='object'?raw.usage:{}};
}
async function request(path,body) {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),55000);
  try {
    const response=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,cache:'no-store',signal:controller.signal});
    let result;try{result=await response.json();}catch{throw new Error('AI 서비스에 연결되지 않았습니다. 로컬 근거 조회를 이용하세요.');}
    if(!response.ok)throw new Error(String(result.error?.message||result.message||result.error||'AI 서비스가 요청을 처리하지 못했습니다.').slice(0,400));
    return result;
  }catch(error){if(error.name==='AbortError')throw new Error('AI 응답 시간이 초과되었습니다. 분석 결과를 생성하지 않았습니다.');throw error;}finally{clearTimeout(timer);}
}
export const getAIStatus = () => request('/api/ai/status');
export const askProjectAI = async(question,context) => normalizeAIResult(await request('/api/ai/assist',{question,context}));
export const generateAIReport = async context => ({context_key:analysisContextKey(context),generated_at:new Date().toISOString(),result:normalizeAIResult(await request('/api/ai/report',{context}))});
export function matchingAIAnalysis(context,analysis) {
  if(!analysis || analysis.context_key!==analysisContextKey(context))return null;
  try{return {...normalizeAIResult(analysis.result),generated_at:analysis.generated_at};}catch{return null;}
}
