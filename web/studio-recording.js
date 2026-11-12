/** User-initiated capture of the local 3D canvas only. No screen or microphone access. */
export function mountSceneRecording({container,getCanvas,notify}) {
  const button=document.createElement('button');button.type='button';button.textContent='3D 영상 저장';button.title='현재 3D 편집 화면을 WebM 영상으로 저장합니다. UI·마이크·Isaac 영상은 포함하지 않습니다.';button.id='record-scene';container.append(button);
  let recorder=null,stream=null,timer=null,parts=[],bytes=0;
  const stop=()=>{if(recorder?.state==='recording')recorder.stop();};
  const cleanup=()=>{clearTimeout(timer);stream?.getTracks().forEach(track=>track.stop());stream=null;recorder=null;button.textContent='3D 영상 저장';button.classList.remove('is-recording');button.setAttribute('aria-pressed','false');};
  button.addEventListener('click',()=>{
    if(recorder){stop();return;}
    const canvas=getCanvas();if(!canvas?.captureStream||typeof MediaRecorder==='undefined'){notify('이 브라우저는 3D 영상 저장을 지원하지 않습니다.');return;}
    try{
      stream=canvas.captureStream(30);const mimeType=['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'].find(type=>MediaRecorder.isTypeSupported(type));
      recorder=new MediaRecorder(stream,mimeType?{mimeType,videoBitsPerSecond:6000000}:{});parts=[];bytes=0;
      recorder.addEventListener('dataavailable',event=>{if(event.data.size){parts.push(event.data);bytes+=event.data.size;if(bytes>100*1024*1024)stop();}});
      recorder.addEventListener('stop',()=>{const type=recorder.mimeType||'video/webm';const blob=new Blob(parts,{type});parts=[];cleanup();if(!blob.size){notify('녹화된 영상이 없습니다.');return;}const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`RoboCell_3D편집_${new Date().toISOString().replace(/[:.]/g,'-')}.webm`;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);notify('3D 편집 화면 영상을 저장했습니다. Isaac Sim 실행 영상과 별개입니다.');});
      recorder.addEventListener('error',()=>{cleanup();notify('영상 저장 중 오류가 발생했습니다.');});
      recorder.start(1000);button.textContent='● 녹화 종료';button.classList.add('is-recording');button.setAttribute('aria-pressed','true');timer=setTimeout(stop,180000);notify('3D 화면 녹화 중 · 시점을 움직인 후 녹화 종료를 누르세요. 최대 3분.');
    }catch{cleanup();notify('3D 영상 녹화를 시작하지 못했습니다.');}
  });
  window.addEventListener('beforeunload',stop);
  return {stop,dispose(){stop();window.removeEventListener('beforeunload',stop);button.remove();}};
}
