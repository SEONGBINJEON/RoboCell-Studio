import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../web/vendor/three/three.module.js';
import { FactoryScene } from '../web/studio-scene.js';
import { createDefaultLayout } from '../web/studio-model.js';
import { fitPerspectivePoints } from '../web/studio-scene-math.js';

function dragScene(step=.25){
  const moves=[];
  return {moves,snapStep:step,point:{x:1,y:2},drag:{id:'machine',pointerId:4,offsetX:0,offsetY:0,lastX:1,lastY:2,moved:false},
    getWorldPoint(){return this.point;},callbacks:{onMove:(id,point)=>moves.push({id,...point})}};
}

test('snap changes affect real drag coordinates without repeated callbacks inside one grid cell',()=>{
  const scene=dragScene();
  scene.point={x:1.11,y:2.11};FactoryScene.prototype.pointerMove.call(scene,{pointerId:4});
  assert.equal(scene.moves.length,0);assert.equal(scene.drag.moved,false);
  scene.point={x:1.16,y:2.16};FactoryScene.prototype.pointerMove.call(scene,{pointerId:4});
  assert.deepEqual(scene.moves,[{id:'machine',x:1.25,y:2.25}]);
  scene.point={x:1.2,y:2.23};FactoryScene.prototype.pointerMove.call(scene,{pointerId:4});
  assert.equal(scene.moves.length,1);
  assert.equal(FactoryScene.prototype.setSnap.call(scene,.1),.1);
  scene.point={x:.26,y:-.16};FactoryScene.prototype.pointerMove.call(scene,{pointerId:4});
  assert.deepEqual(scene.moves.at(-1),{id:'machine',x:.3,y:-.2});
  for(const invalid of [NaN,Infinity,-1,11])assert.equal(FactoryScene.prototype.setSnap.call(scene,invalid),.1);
});

test('free positioning keeps subgrid precision and a second pointer cannot move or end the active drag',()=>{
  const scene=dragScene();FactoryScene.prototype.setSnap.call(scene,0);
  scene.point={x:1.12345,y:2.6789};
  FactoryScene.prototype.pointerMove.call(scene,{pointerId:8});assert.equal(scene.moves.length,0);
  FactoryScene.prototype.pointerMove.call(scene,{pointerId:4});
  assert.deepEqual(scene.moves[0],{id:'machine',x:1.12345,y:2.6789});
  const completed=[],released=[];
  Object.assign(scene,{mode:'move',controls:{enabled:false},canvas:{style:{},hasPointerCapture:id=>id===4,releasePointerCapture:id=>released.push(id)}});
  scene.callbacks.onMoveEnd=id=>completed.push(id);
  FactoryScene.prototype.pointerUp.call(scene,{pointerId:8});assert.ok(scene.drag);assert.equal(scene.controls.enabled,false);
  FactoryScene.prototype.pointerUp.call(scene,{pointerId:4});
  assert.equal(scene.drag,null);assert.equal(scene.controls.enabled,true);assert.deepEqual(completed,['machine']);assert.deepEqual(released,[4]);
});

test('focusing an asset preserves the view direction and shrinks factory-scale labels for useful magnification',()=>{
  const machine=new THREE.Group();machine.position.set(60,0,60);machine.add(new THREE.Mesh(new THREE.BoxGeometry(2,2,2)));
  const label=new THREE.Sprite();label.position.set(60,5,60);label.scale.set(40,6,1);label.userData.baseScale=label.scale.clone();
  const fits=[];
  const scene={objects:new Map([['machine',machine]]),selectedId:'machine',viewportSize:{width:1000,height:700},container:{clientWidth:1000,clientHeight:700},
    camera:{position:new THREE.Vector3(10,10,10)},controls:{target:new THREE.Vector3()},labelsVisible:true,assetLabels:new Map([['machine',label]]),
    applyCameraFit:(bounds,direction,padding)=>fits.push({bounds:bounds.clone(),direction,padding})};
  assert.equal(FactoryScene.prototype.focusSelected.call(scene),true);
  assert.ok(fits[0].bounds.getSize(new THREE.Vector3()).length()<8,'the label must not make a two-meter machine appear tiny');
  assert.ok(fits[0].direction.every(value=>Math.abs(value-1/Math.sqrt(3))<1e-12));
  assert.equal(scene.framing,'selection');assert.equal(scene.fitted,true);
  scene.container.clientWidth=0;
  assert.equal(FactoryScene.prototype.focusSelected.call(scene),false);assert.equal(fits.length,1);
});

test('whole-factory fit excludes hidden labels and restores the factory-sized visible asset label',()=>{
  const ground=new THREE.Group();ground.add(new THREE.Mesh(new THREE.BoxGeometry(24,.2,18)));
  const dimensions=new THREE.Group();dimensions.visible=false;const hidden=new THREE.Sprite();hidden.position.set(500,0,0);dimensions.add(hidden);ground.add(dimensions);
  const labels=new THREE.Group(),label=new THREE.Sprite();label.scale.set(2,1,1);label.position.set(0,2,0);
  label.userData={baseScale:new THREE.Vector3(5,1,1),anchorY:2,baseOffset:.5};labels.add(label);
  const fits=[];
  const scene={layout:{},viewportSize:{width:1000,height:700},container:{clientWidth:1000,clientHeight:700},assetLabels:new Map([['asset',label]]),
    ground,assetRoot:new THREE.Group(),labelRoot:labels,view:'perspective',applyCameraFit:bounds=>fits.push(bounds.clone())};
  FactoryScene.prototype.fit.call(scene);
  assert.deepEqual(label.scale.toArray(),[5,1,1]);assert.equal(label.position.y,2.5);
  assert.equal(fits[0].min.x,-12);assert.equal(fits[0].max.x,12);assert.equal(scene.framing,'factory');
});

test('real default scene fills the workbench while all geometry and billboard corners remain visible',()=>{
  const previousDocument=globalThis.document;
  // Texture drawing is irrelevant to the geometry. Approximate glyph advance
  // supplies realistic Korean/Latin label sizes without requiring WebGL/DOM.
  globalThis.document={createElement:()=>({getContext:()=>({measureText:text=>({width:[...text].reduce((sum,c)=>sum+(c.charCodeAt(0)>255?44:25),0)}),clearRect(){},fillRect(){},strokeRect(){},fillText(){}})})};
  try{
    let captured;
    const scene=Object.assign(Object.create(FactoryScene.prototype),{
      objects:new Map(),assetLabels:new Map(),assetRoot:new THREE.Group(),ground:new THREE.Group(),labelRoot:new THREE.Group(),sun:new THREE.DirectionalLight(),
      gridVisible:true,labelsVisible:true,viewportSize:{width:790,height:470},container:{clientWidth:790,clientHeight:470},view:'perspective',updateSelection(){},
      applyCameraFit(bounds,direction,padding,points){captured={bounds,direction,padding,points};},
    });
    const layout=createDefaultLayout();scene.setLayout(layout);
    const project=aspect=>{
      const fit=fitPerspectivePoints({...captured,aspect,fovDegrees:39});
      const camera=new THREE.PerspectiveCamera(39,aspect,.1,fit.far);camera.position.fromArray(fit.position);camera.lookAt(new THREE.Vector3(...fit.target));camera.updateMatrixWorld();
      for(const p of captured.points){const projected=new THREE.Vector3(...p).project(camera);assert.ok(Math.abs(projected.x)<=1/1.07+1e-8);assert.ok(Math.abs(projected.y)<=1/1.07+1e-8);assert.ok(projected.z>-1&&projected.z<1);}
      return camera;
    };
    const camera=project(790/470),corners=[[-12,0,-9],[12,0,-9],[-12,0,9],[12,0,9]].map(p=>new THREE.Vector3(...p).project(camera));
    const widthFraction=(Math.max(...corners.map(p=>p.x))-Math.min(...corners.map(p=>p.x)))/2;
    assert.ok(widthFraction>=.75&&widthFraction<=.85,`floor uses ${(widthFraction*100).toFixed(1)}% of the viewport`);
    for(const view of ['top','front']){scene.setView(view);project(790/470);project(.4);}
    const large=createDefaultLayout();large.factory={width:200,depth:120,height:30};scene.view='perspective';scene.setLayout(large);project(790/470);project(.4);
  }finally{if(previousDocument===undefined)delete globalThis.document;else globalThis.document=previousDocument;}
});
