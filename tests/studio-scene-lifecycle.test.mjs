import test from 'node:test';
import assert from 'node:assert/strict';
import { FactoryScene } from '../web/studio-scene.js';

test('hiding the editor preserves the last renderer size and camera instead of fitting a 1x1 canvas',()=>{
  const calls=[];
  const scene={container:{clientWidth:0,clientHeight:0},viewportSize:{width:412,height:400},camera:{aspect:1.03},
    renderer:{setSize:()=>calls.push('resize')},fit:()=>calls.push('fit'),updateRenderActivity:()=>calls.push('activity')};
  FactoryScene.prototype.resize.call(scene);
  assert.deepEqual(calls,['activity']);
  assert.deepEqual(scene.viewportSize,{width:412,height:400});
  assert.equal(scene.camera.aspect,1.03);
});

test('resuming the same viewport preserves orbit while a changed visible viewport refits',()=>{
  const calls=[];
  const scene={container:{clientWidth:412,clientHeight:400},viewportSize:{width:412,height:400},layout:{},fitted:true,fitPending:false,
    camera:{aspect:1.03,updateProjectionMatrix:()=>calls.push('projection')},renderer:{setSize:()=>calls.push('resize')},
    fit:()=>calls.push('fit'),updateRenderActivity:()=>calls.push('activity')};
  FactoryScene.prototype.resize.call(scene);
  assert.deepEqual(calls,['activity']);
  calls.length=0;scene.container.clientWidth=300;
  FactoryScene.prototype.resize.call(scene);
  assert.deepEqual(calls,['resize','projection','fit','activity']);
  assert.equal(scene.camera.aspect,.75);
});

test('explicit fit while hidden is deferred until the editor becomes visible',()=>{
  const scene={layout:{},container:{clientWidth:0,clientHeight:0},viewportSize:{width:412,height:400},fitPending:false};
  FactoryScene.prototype.fit.call(scene);
  assert.equal(scene.fitPending,true);
  const calls=[];
  Object.assign(scene,{container:{clientWidth:412,clientHeight:400},fit:()=>calls.push('fit'),updateRenderActivity:()=>{}});
  FactoryScene.prototype.resize.call(scene);
  assert.deepEqual(calls,['fit']);
});

test('inactive and background views cancel RAF; resuming schedules exactly one loop',()=>{
  const oldDocument=globalThis.document,oldRaf=globalThis.requestAnimationFrame,oldCancel=globalThis.cancelAnimationFrame;
  const requested=[],cancelled=[];
  try{
    globalThis.document={hidden:false};
    globalThis.requestAnimationFrame=callback=>{requested.push(callback);return requested.length;};
    globalThis.cancelAnimationFrame=id=>cancelled.push(id);
    const scene={container:{clientWidth:412,clientHeight:400},requestedActive:true,disposed:false,active:false,frame:null,animate:()=>{}};
    FactoryScene.prototype.updateRenderActivity.call(scene);
    FactoryScene.prototype.updateRenderActivity.call(scene);
    assert.equal(requested.length,1);assert.equal(scene.active,true);
    scene.requestedActive=false;FactoryScene.prototype.updateRenderActivity.call(scene);
    assert.deepEqual(cancelled,[1]);assert.equal(scene.frame,null);assert.equal(scene.active,false);
    scene.requestedActive=true;globalThis.document.hidden=true;FactoryScene.prototype.updateRenderActivity.call(scene);
    assert.equal(requested.length,1);
    globalThis.document.hidden=false;FactoryScene.prototype.updateRenderActivity.call(scene);
    assert.equal(requested.length,2);assert.equal(scene.active,true);
  }finally{
    if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
    if(oldRaf===undefined)delete globalThis.requestAnimationFrame;else globalThis.requestAnimationFrame=oldRaf;
    if(oldCancel===undefined)delete globalThis.cancelAnimationFrame;else globalThis.cancelAnimationFrame=oldCancel;
  }
});
