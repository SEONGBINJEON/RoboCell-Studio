import * as THREE from './vendor/three/three.module.js';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { CATALOG } from './studio-model.js';
import { fitPerspectiveBox, fitPerspectivePoints } from './studio-scene-math.js';
import { buildEngineeringAsset } from './studio-scene-assets.js';

const catalog = new Map(CATALOG.map(item => [item.type, item]));
const palette = { yellow: 0xffd233, steel: 0x8b98a8, dark: 0x242c37, light: 0xecf0f5, teal: 0x80a9b2, rubber: 0x141c25, orange: 0xd98b32 };

function material(color, extra = {}) { return new THREE.MeshStandardMaterial({ color, roughness: .46, metalness: .22, ...extra }); }
function box(parent, w, h, d, x, y, z, color, extra) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material(color, extra));
  mesh.position.set(x,y,z); mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh);
  // A fine technical edge keeps white machine panels legible at working zoom.
  if(Math.max(w,h,d)>.45&&!extra?.transparent){
    const c=new THREE.Color(color),bright=(c.r+c.g+c.b)/3>.45;
    const edges=new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry),new THREE.LineBasicMaterial({color:bright?0x425061:0x93a1b1,transparent:true,opacity:bright?.28:.17}));
    edges.raycast=()=>{};mesh.add(edges);
  }
  return mesh;
}
function cylinder(parent, r, height, x,y,z,color, segments=24) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r,r,height,segments),material(color));
  mesh.position.set(x,y,z);mesh.castShadow = true;mesh.receiveShadow = true;parent.add(mesh);return mesh;
}
function tubeBetween(parent,a,b,r,color) {
  const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b), direction = end.clone().sub(start);
  const mesh = cylinder(parent,r,direction.length(),0,0,0,color);
  mesh.position.copy(start.clone().add(end).multiplyScalar(.5));mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),direction.normalize());return mesh;
}
function disposeTree(root) {
  const materials = new Set(), geometries = new Set(), textures = new Set();
  root.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    const list = object.material ? (Array.isArray(object.material) ? object.material : [object.material]) : [];
    list.forEach(m => { materials.add(m); if(m.map) textures.add(m.map); });
  });
  geometries.forEach(g => g.dispose());materials.forEach(m => m.dispose());textures.forEach(t => t.dispose());
}
function textSprite(text, { color = '#edf3fc', background = '#151d28', border = '#526071', width = 3.2, height = null, font = '600 44px "IBM Plex Sans KR", "Segoe UI", sans-serif' } = {}) {
  const canvas = document.createElement('canvas'),context=canvas.getContext('2d');context.font=font;
  canvas.width=Math.ceil(context.measureText(text).width+48);canvas.height=82;
  context.clearRect(0,0,canvas.width,canvas.height);
  if(background){context.fillStyle=background;context.fillRect(0,0,canvas.width,canvas.height);}
  if(border){context.strokeStyle=border;context.lineWidth=2;context.strokeRect(1,1,canvas.width-2,canvas.height-2);}
  context.fillStyle=color;context.font=font;context.textAlign='center';context.textBaseline='middle';context.fillText(text,canvas.width/2,canvas.height/2+1,canvas.width-32);
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
  const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,transparent:true,depthTest:false,depthWrite:false,toneMapped:false}));
  if(height!==null)width=height*canvas.width/canvas.height;
  sprite.scale.set(width,width*canvas.height/canvas.width,1);sprite.renderOrder=8;return sprite;
}
function segments(parent,points,color=0x8696aa,opacity=1,dashed=false){
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(points,3));
  const line=new THREE.LineSegments(geometry,dashed?new THREE.LineDashedMaterial({color,transparent:true,opacity,dashSize:.14,gapSize:.1}):new THREE.LineBasicMaterial({color,transparent:true,opacity}));
  line.raycast=()=>{};if(dashed)line.computeLineDistances();parent.add(line);return line;
}
function floorLines(parent,width,depth){
  const group=new THREE.Group(),minor=[],major=[];
  // Meter markings use the same lower-left origin as the layout coordinates.
  for(let m=0;m<=width;m++){const p=m%5===0?major:minor,x=m-width/2;p.push(x,.013,-depth/2,x,.013,depth/2);}
  for(let m=0;m<=depth;m++){const p=m%5===0?major:minor,z=m-depth/2;p.push(-width/2,.013,z,width/2,.013,z);}
  segments(group,minor,0x3b4a53,.12);segments(group,major,0x33464f,.24);parent.add(group);return group;
}

function workshopEnvironment(renderer){
  const room=new THREE.Scene();room.background=new THREE.Color(0x8d9ba8);
  const shell=new THREE.Mesh(new THREE.BoxGeometry(18,12,18),new THREE.MeshBasicMaterial({color:0x9caab5,side:THREE.BackSide}));room.add(shell);
  for(const [x,y,z,w,h,d,intensity] of [[0,5.7,0,12,.1,7,4],[-8,2,0,.1,5,12,2],[4,2,8,8,4,.1,3],[0,-5.8,0,16,.1,16,.35]]){
    const light=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),new THREE.MeshBasicMaterial({color:new THREE.Color().setRGB(intensity,intensity,intensity)}));light.position.set(x,y,z);room.add(light);
  }
  const generator=new THREE.PMREMGenerator(renderer),target=generator.fromScene(room,.06,.1,50);generator.dispose();disposeTree(room);return target;
}
function epoxyTexture(){
  const canvas=document.createElement('canvas');canvas.width=512;canvas.height=512;const ctx=canvas.getContext('2d');
  ctx.fillStyle='#7c8a92';ctx.fillRect(0,0,512,512);let seed=7349;
  for(let i=0;i<18000;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const x=seed%512;seed=(Math.imul(seed,1664525)+1013904223)>>>0;const y=seed%512;ctx.fillStyle=i%2?'rgba(235,241,242,.055)':'rgba(47,62,71,.045)';ctx.fillRect(x,y,1,1);}
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.anisotropy=4;return texture;
}
function outline(parent,width,depth,color=0xefc719,y=.025,dashed=false) {
  const points=[[-width/2,y,-depth/2],[width/2,y,-depth/2],[width/2,y,depth/2],[-width/2,y,depth/2],[-width/2,y,-depth/2]].map(p=>new THREE.Vector3(...p));
  const geometry=new THREE.BufferGeometry().setFromPoints(points);
  const line = new THREE.Line(geometry,dashed?new THREE.LineDashedMaterial({color,dashSize:.2,gapSize:.12}):new THREE.LineBasicMaterial({color}));
  line.computeLineDistances();parent.add(line);return line;
}

function visibleBounds(...roots){
  const bounds=new THREE.Box3(),box=new THREE.Box3();
  const visit=object=>{
    if(!object.visible)return;
    if(object.isSprite){const center=object.getWorldPosition(new THREE.Vector3()),scale=object.getWorldScale(new THREE.Vector3()),radius=Math.hypot(scale.x,scale.y)/2;bounds.expandByPoint(center.clone().addScalar(radius));bounds.expandByPoint(center.clone().addScalar(-radius));}
    else if(object.geometry){if(!object.geometry.boundingBox)object.geometry.computeBoundingBox();box.copy(object.geometry.boundingBox).applyMatrix4(object.matrixWorld);bounds.union(box);}
    object.children.forEach(visit);
  };
  roots.filter(Boolean).forEach(root=>{root.updateMatrixWorld(true);visit(root);});return bounds;
}

function visiblePoints(direction,...roots){
  const points=[],backward=new THREE.Vector3(...direction).normalize(),right=Math.abs(backward.y)>1-1e-10?new THREE.Vector3(1,0,0):new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0),backward).normalize();
  const up=new THREE.Vector3().crossVectors(backward,right).normalize(),vertex=new THREE.Vector3();
  const visit=object=>{
    if(!object.visible)return;
    if(object.isSprite){
      const center=object.getWorldPosition(new THREE.Vector3()),scale=object.getWorldScale(new THREE.Vector3());
      // Billboards occupy a camera-facing rectangle, not a world-axis sphere.
      for(const x of [0,1])for(const y of [0,1])points.push(center.clone().addScaledVector(right,(x-object.center.x)*scale.x).addScaledVector(up,(y-object.center.y)*scale.y).toArray());
    }else if(object.geometry?.attributes.position){
      // Detailed static meshes are material batches. Their eight local bounds
      // corners provide a conservative fit without walking every CAD vertex.
      if(!object.geometry.boundingBox)object.geometry.computeBoundingBox();const b=object.geometry.boundingBox;
      for(const x of [b.min.x,b.max.x])for(const y of [b.min.y,b.max.y])for(const z of [b.min.z,b.max.z])points.push(vertex.set(x,y,z).applyMatrix4(object.matrixWorld).toArray());
    }
    object.children.forEach(visit);
  };
  roots.filter(Boolean).forEach(root=>{root.updateMatrixWorld(true);visit(root);});return points;
}

function selectionFootprint(){
  const group=new THREE.Group();
  const material=new THREE.MeshBasicMaterial({color:palette.yellow,depthTest:false,depthWrite:false});
  for(const x of [-1,1])for(const z of [-1,1])for(const axis of ['x','z']){
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),material);mesh.userData={x,z,axis};mesh.renderOrder=7;group.add(mesh);
  }
  group.visible=false;return group;
}

function zone(asset){
  const g=new THREE.Group(),worker=asset.type==='worker-zone';
  box(g,asset.width,.016,asset.depth,0,.023,0,worker?0x548e9f:0xd8ae24,{transparent:true,opacity:worker?.25:.15,roughness:1,metalness:0,depthWrite:false});
  outline(g,asset.width,asset.depth,worker?0x86cadb:palette.yellow,.045,true);
  if(worker){
    // A static scale figure marks the worker zone; it is not a simulated person.
    const figure=new THREE.Group();figure.userData.staticScaleFigure=true;figure.userData.referenceHeight=1.7;g.add(figure);
    const head=new THREE.Mesh(new THREE.SphereGeometry(.112,16,12),material(0xc6aa91,{roughness:.8,metalness:0}));head.position.set(0,1.57,0);figure.add(head);
    const helmet=new THREE.Mesh(new THREE.SphereGeometry(.135,16,8,0,Math.PI*2,0,Math.PI/2),material(palette.yellow));helmet.position.set(0,1.61,0);figure.add(helmet);
    cylinder(figure,.145,.025,0,1.61,0,palette.yellow);
    const torso=new THREE.Mesh(new THREE.CapsuleGeometry(.145,.29,6,12),material(0xe1a932,{roughness:.8,metalness:0}));torso.position.set(0,1.22,0);figure.add(torso);
    box(figure,.27,.025,.23,0,1.19,.01,0xc9d8d8);box(figure,.27,.025,.21,0,1.04,.01,0xc9d8d8);
    cylinder(figure,.13,.17,0,.91,0,0x3c5269);
    for(const sign of [-1,1]){
      tubeBetween(figure,[sign*.075,.88,0],[sign*.13,.49,.015],.068,0x3c5269);tubeBetween(figure,[sign*.13,.49,.015],[sign*.14,.16,.04],.058,0x3c5269);
      box(figure,.13,.1,.25,sign*.14,.105,.095,palette.rubber);
      tubeBetween(figure,[sign*.16,1.38,0],[sign*.25,1.08,.02],.054,0x667b8c);tubeBetween(figure,[sign*.25,1.08,.02],[sign*.25,.86,.08],.045,0x667b8c);
      const hand=new THREE.Mesh(new THREE.SphereGeometry(.052,12,8),material(0xc6aa91));hand.position.set(sign*.25,.84,.08);figure.add(hand);
    }
  }else{
    for(const sign of [-1,1])box(g,asset.width,.008,.035,0,.046,sign*(asset.depth/2-.025),palette.yellow,{roughness:.85,metalness:0});
    for(let x=-asset.width/2+1;x<asset.width/2;x+=2){
      const shape=new THREE.Shape();shape.moveTo(-.22,-.24);shape.lineTo(.02,-.24);shape.lineTo(.02,-.42);shape.lineTo(.43,0);shape.lineTo(.02,.42);shape.lineTo(.02,.24);shape.lineTo(-.22,.24);shape.closePath();
      const mesh=new THREE.Mesh(new THREE.ShapeGeometry(shape),new THREE.MeshBasicMaterial({color:0xc5a844,side:THREE.DoubleSide}));mesh.rotation.x=-Math.PI/2;mesh.position.set(x,.05,0);g.add(mesh);
    }
  }
  return g;
}
function buildAsset(asset) {
  if(asset.type==='worker-zone'||asset.type==='walkway')return zone(catalog.get(asset.type));
  return buildEngineeringAsset(asset,catalog.get(asset.type));
}

export class FactoryScene {
  constructor(container, {onSelect=()=>{},onMove=()=>{},onMoveEnd=()=>{},onError=()=>{},onStats=()=>{}}={}) {
    this.container=container;this.callbacks={onSelect,onMove,onMoveEnd,onError,onStats};this.objects=new Map();this.mode='move';this.selectedId=null;this.view='perspective';this.disposed=false;
    this.frameStats={startedAt:null,frames:0,published:false};
    this.requestedActive=true;this.active=false;this.frame=null;this.viewportSize=null;this.fitPending=false;
    this.gridVisible=true;this.labelsVisible=true;this.namesVisible=false;this.snapStep=.25;this.assetLabels=new Map();this.framing='factory';
    this.scene=new THREE.Scene();this.scene.background=new THREE.Color(0x151b24);
    this.camera=new THREE.PerspectiveCamera(34,1,.1,1000);
    this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,preserveDrawingBuffer:true});
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=.94;
    this.environmentTarget=workshopEnvironment(this.renderer);this.scene.environment=this.environmentTarget.texture;this.scene.environmentIntensity=.68;
    this.canvas=this.renderer.domElement;this.canvas.style.cssText='display:block;width:100%;height:100%;touch-action:none;outline:none;';this.canvas.tabIndex=0;
    this.canvas.setAttribute('aria-label','3D 공장 배치. 장비를 클릭하거나 드래그하여 이동할 수 있습니다.');container.append(this.canvas);
    this.controls=new OrbitControls(this.camera,this.canvas);this.controls.enableDamping=true;this.controls.dampingFactor=.09;this.controls.maxPolarAngle=Math.PI/2-.045;this.controls.minDistance=.8;this.controls.maxDistance=350;this.controls.screenSpacePanning=true;
    this.scene.add(new THREE.HemisphereLight(0xe9f1ff,0x3c4651,.85));
    this.sun=new THREE.DirectionalLight(0xfff8e9,2.25);this.sun.position.set(-10,25,15);this.sun.castShadow=true;this.sun.shadow.mapSize.set(2048,2048);this.sun.shadow.normalBias=.018;this.sun.shadow.bias=-.00015;this.sun.shadow.radius=3;this.scene.add(this.sun);
    const fill=new THREE.DirectionalLight(0xd2e5ff,.85);fill.position.set(20,12,-18);this.scene.add(fill);
    this.ground=new THREE.Group();this.scene.add(this.ground);this.assetRoot=new THREE.Group();this.scene.add(this.assetRoot);this.labelRoot=new THREE.Group();this.scene.add(this.labelRoot);
    this.selection=new THREE.Box3Helper(new THREE.Box3(),palette.yellow);this.selection.visible=false;this.selection.renderOrder=7;this.selection.material.depthTest=false;this.selection.material.depthWrite=false;this.selection.material.toneMapped=false;this.scene.add(this.selection);
    this.selectionFootprint=selectionFootprint();this.scene.add(this.selectionFootprint);
    this.selectionAxes=new THREE.Group();this.scene.add(this.selectionAxes);this.selectionAxes.visible=false;
    for(const [direction,color,label,position] of [[new THREE.Vector3(1,0,0),0xe28172,'X',[1.12,.1,0]],[new THREE.Vector3(0,0,1),0x82b795,'Y',[0,.1,1.12]]]){
      const arrow=new THREE.ArrowHelper(direction,new THREE.Vector3(0,.08,0),.92,color,.17,.09);arrow.line.material.depthTest=false;arrow.cone.material.depthTest=false;arrow.line.material.toneMapped=false;arrow.cone.material.toneMapped=false;arrow.line.renderOrder=9;arrow.cone.renderOrder=9;this.selectionAxes.add(arrow);
      const text=textSprite(label,{width:.3,color:color===0xe28172?'#f2a18e':'#a4d2b4',background:null,border:null});text.position.set(...position);this.selectionAxes.add(text);
    }
    this.raycaster=new THREE.Raycaster();this.plane=new THREE.Plane(new THREE.Vector3(0,1,0),0);this.pointer=new THREE.Vector2();
    this.down=e=>this.pointerDown(e);this.move=e=>this.pointerMove(e);this.up=e=>this.pointerUp(e);
    this.canvas.addEventListener('pointerdown',this.down,true);this.canvas.addEventListener('pointermove',this.move);this.canvas.addEventListener('pointerup',this.up);this.canvas.addEventListener('pointercancel',this.up);
    this.lost=event=>{event.preventDefault();this.contextLost=true;this.updateRenderActivity();this.callbacks.onError('3D 화면 연결이 중단됐습니다. 페이지를 새로고침해 주세요.');};this.canvas.addEventListener('webglcontextlost',this.lost);
    this.orbitStart=()=>{this.cameraTransition=null;};this.controls.addEventListener('start',this.orbitStart);
    this.animate=()=>{this.frame=null;if(!this.active||this.disposed)return;if(this.cameraTransition){const t=this.cameraTransition,p=Math.min(1,(performance.now()-t.start)/420),s=p*p*(3-2*p);this.camera.position.lerpVectors(t.fromPosition,t.toPosition,s);this.controls.target.lerpVectors(t.fromTarget,t.toTarget,s);if(p===1)this.cameraTransition=null;}this.controls.update();this.renderer.render(this.scene,this.camera);this.recordRenderedFrame(performance.now());this.frame=requestAnimationFrame(this.animate);};
    this.visibilityChange=()=>this.updateRenderActivity();document.addEventListener('visibilitychange',this.visibilityChange);
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(container);this.resize();
  }
  // Sample completed renderer.render calls, not requested RAF callbacks or an
  // assumed monitor rate. This is editor loop FPS, not Isaac or GPU timing.
  recordRenderedFrame(now){
    const stats=this.frameStats;
    if(!this.active||!Number.isFinite(now))return;
    if(stats.startedAt===null||now<stats.startedAt){stats.startedAt=now;stats.frames=0;return;}
    stats.frames++;
    const elapsed=now-stats.startedAt;if(elapsed<1000)return;
    const info=this.renderer.info?.render||{};
    this.callbacks.onStats?.({fps:stats.frames*1000/elapsed,drawCalls:Number.isFinite(info.calls)?info.calls:null,triangles:Number.isFinite(info.triangles)?info.triangles:null});
    stats.startedAt=now;stats.frames=0;stats.published=true;
  }
  resetFrameStats(){
    if(!this.frameStats)return;
    const published=this.frameStats.published;this.frameStats={startedAt:null,frames:0,published:false};
    if(published)this.callbacks.onStats?.({fps:null,drawCalls:null,triangles:null});
  }
  updateRenderActivity(){
    const visible=this.container.clientWidth>1&&this.container.clientHeight>1;
    this.active=!this.disposed&&!this.contextLost&&this.requestedActive&&!document.hidden&&visible;
    if(!this.active){if(this.frame!==null)cancelAnimationFrame(this.frame);this.frame=null;this.resetFrameStats?.();return;}
    if(this.frame===null)this.frame=requestAnimationFrame(this.animate);
  }
  setActive(active){
    this.requestedActive=Boolean(active);
    if(!this.requestedActive&&this.drag)this.pointerUp({pointerId:this.drag.pointerId});
    if(this.requestedActive)this.resize();
    this.updateRenderActivity();
  }
  resize(){
    const width=this.container.clientWidth,height=this.container.clientHeight;
    // display:none must not replace a useful aspect/framing with a 1x1 camera.
    if(width<=1||height<=1){this.updateRenderActivity();return;}
    const changed=!this.viewportSize||this.viewportSize.width!==width||this.viewportSize.height!==height;
    if(changed){this.viewportSize={width,height};this.renderer.setSize(width,height,false);this.camera.aspect=width/height;this.camera.updateProjectionMatrix();}
    if(this.layout&&(this.fitPending||(changed&&this.fitted))){if(this.framing==='selection'&&!this.fitPending){if(!this.focusSelected())this.fit();}else this.fit();}
    this.updateRenderActivity();
  }
  setLayout(layout){
    const oldFactory=this.layout?.factory;this.layout=layout;
    if(!oldFactory||['width','depth','height'].some(k=>oldFactory[k]!==layout.factory[k])||this.factoryKey!==JSON.stringify(layout.factory)){
      this.rebuildGround();this.factoryKey=JSON.stringify(layout.factory);this.fitPending=true;
    }
    const ids=new Set(layout.assets.map(a=>a.id));
    for(const [id,group]of this.objects){if(!ids.has(id)){this.assetRoot.remove(group);disposeTree(group);this.objects.delete(id);}}
    for(const [id,label]of this.assetLabels){if(!ids.has(id)){this.labelRoot.remove(label);disposeTree(label);this.assetLabels.delete(id);}}
    const labelScale=Math.max(1,Math.max(layout.factory.width,layout.factory.depth)/40);
    for(const asset of layout.assets){
      let group=this.objects.get(asset.id);
      if(group&&group.userData.type!==asset.type){this.assetRoot.remove(group);disposeTree(group);this.objects.delete(asset.id);group=null;}
      if(!group){group=buildAsset(asset);group.userData.assetId=asset.id;group.userData.type=asset.type;this.objects.set(asset.id,group);this.assetRoot.add(group);}
      const def=catalog.get(asset.type);group.position.set(asset.x-layout.factory.width/2,0,asset.y-layout.factory.depth/2);group.rotation.y=-asset.rotation*Math.PI/180;
      group.scale.set(asset.width/def.width,asset.height/def.height,asset.depth/def.depth);
      // Zone height controls the floor marking, not the schematic person symbol.
      if(asset.type==='worker-zone'||asset.type==='walkway')group.scale.y=1;
      if(asset.type==='worker-zone'){
        const figure=group.children.find(child=>child.userData.staticScaleFigure);
        // Keep the person proportional when the zone changes width/depth. Tiny
        // zones reduce the complete figure uniformly so it stays inside them.
        if(figure){const scale=1.7/1.745*Math.min(1,asset.width/.65,asset.depth/.45);figure.scale.set(scale*def.width/asset.width,scale,scale*def.depth/asset.depth);}
      }
      group.updateMatrixWorld(true);
      let label=this.assetLabels.get(asset.id);
      const labelKey=`${asset.name}|${labelScale}`;
      if(!label||label.userData.labelKey!==labelKey){
        if(label){this.labelRoot.remove(label);disposeTree(label);}
        label=textSprite(asset.name.length>18?`${asset.name.slice(0,17)}…`:asset.name,{height:.38*labelScale,color:'#cbd6e5',background:'rgba(21,29,40,.78)',border:'#526071',font:'500 40px "IBM Plex Sans KR", "Segoe UI", sans-serif'});label.userData.labelKey=labelKey;label.userData.baseScale=label.scale.clone();
        this.assetLabels.set(asset.id,label);this.labelRoot.add(label);
      }
      const bounds=new THREE.Box3().setFromObject(group);
      label.userData.anchorY=bounds.max.y;label.userData.baseOffset=.5*labelScale;
      label.position.set(group.position.x,bounds.max.y+.5*labelScale,group.position.z);
    }
    if(this.modelDetail==='wireframe')this.setModelDetail('wireframe');
    this.updateSelection();if(!this.fitted||this.fitPending)this.fit();
  }
  rebuildGround(){
    disposeTree(this.ground);this.ground.clear();const {width:w,depth:d,height:h}=this.layout.factory;
    const scale=Math.max(w,d)/24,offset=Math.max(.65,scale),tick=Math.max(.12,scale*.15);
    const finish=epoxyTexture();finish.repeat.set(Math.max(1,w/8),Math.max(1,d/8));
    box(this.ground,w+.12,.28,d+.12,0,-.2,0,0x283440,{roughness:.73,metalness:.18});
    box(this.ground,w,.12,d,0,-.06,0,0xffffff,{map:finish,roughness:.78,metalness:.04});
    this.grid=floorLines(this.ground,w,d);this.grid.visible=this.gridVisible;outline(this.ground,w,d,0x71808b,.019);
    // Cutaway boundary context is a visual dimension guide, not surveyed walls.
    const wallHeight=Math.min(2.2,h*.42),wallOptions={roughness:.68,metalness:.12,transparent:true,opacity:.22,depthWrite:false};
    box(this.ground,w,wallHeight,.055,0,wallHeight/2,-d/2,0xb8c5ce,wallOptions);
    box(this.ground,.055,wallHeight,d,-w/2,wallHeight/2,0,0xb8c5ce,{...wallOptions,opacity:.14});
    for(let at=0;at<=w;at+=Math.max(4,w/5)){
      const x=at-w/2;box(this.ground,.1,h,.1,x,h/2,-d/2,0x7c8d99,{roughness:.45,metalness:.6});
      box(this.ground,.2,.045,.2,x,.022,-d/2,0x455866,{roughness:.5,metalness:.5});
    }
    segments(this.ground,[-w/2,h,-d/2,w/2,h,-d/2,-w/2,h,-d/2,-w/2,h,d/2],0xb0c0cf,.35);
    for(const x of [-w/2,w/2])for(const z of [-d/2,d/2]){
      box(this.ground,.15,.25,.15,x,.125,z,palette.steel);
      segments(this.ground,[x,.25,z,x,h,z],0x6e7f96,.25,true);
    }
    this.dimensions=new THREE.Group();this.dimensions.visible=this.labelsVisible;this.ground.add(this.dimensions);
    const z=d/2+offset,x=w/2+offset;
    segments(this.dimensions,[-w/2,.05,z,w/2,.05,z,-w/2,.05,d/2,-w/2,.05,z+tick,w/2,.05,d/2,w/2,.05,z+tick,
      x,.05,-d/2,x,.05,d/2,w/2,.05,-d/2,x+tick,.05,-d/2,w/2,.05,d/2,x+tick,.05,d/2],0x8a9bb2,.75);
    for(const end of [-1,1]){
      segments(this.dimensions,[end*w/2-tick,.05,z-tick,end*w/2+tick,.05,z+tick,x-tick,.05,end*d/2-tick,x+tick,.05,end*d/2+tick],palette.yellow);
    }
    const labelWidth=Math.max(1.8,2.4*scale);
    const widthLabel=textSprite(`${w.toFixed(1)} m`,{width:labelWidth,color:'#ffe176'});widthLabel.position.set(0,.18,z+offset*.65);this.dimensions.add(widthLabel);
    const depthLabel=textSprite(`${d.toFixed(1)} m`,{width:labelWidth,color:'#ffe176'});depthLabel.position.set(x+offset*.8,.18,0);this.dimensions.add(depthLabel);
    const heightLabel=textSprite(`H ${h.toFixed(1)} m`,{width:labelWidth,color:'#aebed2'});heightLabel.position.set(-w/2,h+offset*.45,-d/2);this.dimensions.add(heightLabel);
    const origin=textSprite('0, 0',{width:Math.max(1.05,1.2*scale),color:'#91a3ba',background:'rgba(21,29,40,.7)',font:'500 38px monospace'});origin.position.set(-w/2,.2,-d/2-offset*.45);this.dimensions.add(origin);
    const half=Math.max(w,d)*.75;this.sun.position.set(-w*.5,Math.max(25,w),d*.7);Object.assign(this.sun.shadow.camera,{left:-half,right:half,top:half,bottom:-half,near:1,far:Math.max(150,this.sun.position.length()+Math.hypot(w,d,h))});this.sun.shadow.camera.updateProjectionMatrix();
  }
  select(id){this.selectedId=id;this.updateSelection();}
  updateSelection(){
    const group=this.objects.get(this.selectedId),asset=this.layout?.assets.find(a=>a.id===this.selectedId);
    this.selection.visible=false;this.selectionFootprint.visible=Boolean(group);this.selectionAxes.visible=Boolean(group);
    for(const [id,object]of this.objects)object.visible=!this.isolationEnabled||!group||id===this.selectedId;
    for(const [id,label]of this.assetLabels){label.visible=(this.namesVisible!==false||id===this.selectedId)&&this.framing!=='selection'&&(!this.isolationEnabled||!group||id===this.selectedId);label.material.color.set(id===this.selectedId?0xffe38a:0xffffff);label.renderOrder=id===this.selectedId?10:8;}
    if(!group||!asset)return;
    this.selectionAxes.position.set(group.position.x,.035,group.position.z);
    this.selection.box.setFromObject(group);this.selection.box.expandByScalar(.075);
    const w=asset.width+.18,d=asset.depth+.18,length=Math.min(.8,Math.min(w,d)*.22),thickness=Math.max(.035,Math.min(w,d)*.012);
    this.selectionFootprint.position.set(group.position.x,.065,group.position.z);this.selectionFootprint.rotation.y=group.rotation.y;
    for(const marker of this.selectionFootprint.children){const {x,z,axis}=marker.userData;marker.scale.set(axis==='x'?length:thickness,.018,axis==='z'?length:thickness);marker.position.set(x*(w/2-(axis==='x'?length/2:0)),0,z*(d/2-(axis==='z'?length/2:0)));}
  }
  setGridVisible(visible){this.gridVisible=Boolean(visible);if(this.grid)this.grid.visible=this.gridVisible;}
  setPlanningEnvelopes(envelopes=[]){
    if(!this.layout)return;
    const key=JSON.stringify([this.layout.factory.width,this.layout.factory.depth,envelopes]);if(this.planningKey===key)return;this.planningKey=key;
    if(!this.planningRoot){this.planningRoot=new THREE.Group();this.scene.add(this.planningRoot);}
    disposeTree(this.planningRoot);this.planningRoot.clear();
    for(const entry of envelopes){
      const color=entry.overlaps.length||entry.outsideFactory?0xe98363:0xd8b364;
      const mesh=new THREE.Mesh(new THREE.CircleGeometry(entry.radius,96),new THREE.MeshBasicMaterial({color,transparent:true,opacity:.13,side:THREE.DoubleSide,depthWrite:false}));
      mesh.rotation.x=-Math.PI/2;mesh.position.set(entry.center.x-this.layout.factory.width/2,.085,entry.center.y-this.layout.factory.depth/2);this.planningRoot.add(mesh);
      const points=[];for(let i=0;i<=96;i++){const t=i/96*Math.PI*2;points.push(new THREE.Vector3(Math.cos(t)*entry.radius,0,Math.sin(t)*entry.radius));}
      const edge=new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),new THREE.LineDashedMaterial({color,dashSize:.2,gapSize:.12,transparent:true,opacity:.95}));edge.computeLineDistances();edge.position.copy(mesh.position);this.planningRoot.add(edge);
    }
  }
  setLabelsVisible(visible){this.labelsVisible=Boolean(visible);if(this.dimensions)this.dimensions.visible=this.labelsVisible;this.labelRoot.visible=this.labelsVisible;}
  setNamesVisible(visible){this.namesVisible=Boolean(visible);this.updateSelection();return this.namesVisible;}
  setModelDetail(mode='solid'){
    this.modelDetail=mode==='wireframe'?'wireframe':'solid';
    this.assetRoot.traverse(object=>{if(object.isMesh&&object.material&&!object.material.map)object.material.wireframe=this.modelDetail==='wireframe';});
    return this.modelDetail;
  }
  isolateSelected(enabled=true){this.isolationEnabled=Boolean(enabled)&&this.objects.has(this.selectedId);this.updateSelection();return this.isolationEnabled;}
  setSnap(value){if(Number.isFinite(value)&&value>=0&&value<=10)this.snapStep=value;return this.snapStep;}
  setMode(mode){this.mode=mode;this.canvas.style.cursor=mode==='orbit'?'grab':'default';}
  setView(view){this.view=view;this.smoothNextFit=true;this.fit();}
  fit(){
    if(!this.layout)return;
    if(!this.viewportSize||this.container.clientWidth<=1||this.container.clientHeight<=1){this.fitPending=true;return;}
    this.framing='factory';
    if(this.dimensions)this.dimensions.visible=this.labelsVisible;
    for(const [id,label]of this.assetLabels){label.scale.copy(label.userData.baseScale);label.position.y=label.userData.anchorY+label.userData.baseOffset;label.visible=(this.namesVisible!==false||id===this.selectedId)&&(!this.isolationEnabled||id===this.selectedId);}
    const direction=this.view==='top'?[0,1,.0001]:this.view==='front'?[0,.22,1]:[.7,.63,1];
    const points=visiblePoints(direction,this.ground,this.assetRoot,this.labelRoot);
    if(!points.length)return;
    const bounds=new THREE.Box3().setFromPoints(points.map(p=>new THREE.Vector3(...p)));
    this.applyCameraFit(bounds,direction,1.07,points);this.framing='factory';this.fitPending=false;this.fitted=true;
  }
  focusSelected(){
    const group=this.objects.get(this.selectedId);
    if(!group||!this.viewportSize||this.container.clientWidth<=1||this.container.clientHeight<=1)return false;
    // Keep the current viewing angle and move the target onto the chosen asset.
    const direction=this.camera.position.clone().sub(this.controls.target).normalize().toArray();
    const geometryBounds=visibleBounds(group),label=this.labelsVisible?this.assetLabels.get(this.selectedId):null;
    for(const item of this.assetLabels.values())item.visible=false;
    if(this.dimensions)this.dimensions.visible=false;
    if(label){
      // A label sized for a 200m factory must not force a tiny selected machine.
      const size=geometryBounds.getSize(new THREE.Vector3()),span=Math.max(size.x,size.z,1.8),base=label.userData.baseScale;
      label.scale.copy(base).multiplyScalar(Math.min(1,.2/base.y,span*.6/base.x));label.position.y=geometryBounds.max.y+.15;label.visible=false;
    }
    const points=visiblePoints(direction,group,label);
    if(!points.length)return false;
    const bounds=new THREE.Box3().setFromPoints(points.map(p=>new THREE.Vector3(...p)));
    this.applyCameraFit(bounds,direction,1.2,points);this.framing='selection';this.fitPending=false;this.fitted=true;return true;
  }
  applyCameraFit(bounds,direction,padding,points){
    const options={direction,fovDegrees:this.camera.fov,aspect:this.camera.aspect,near:this.camera.near,padding};
    const fitted=points?fitPerspectivePoints({...options,points}):fitPerspectiveBox({...options,min:bounds.min.toArray(),max:bounds.max.toArray()});
    // Flush orbit damping from the previous gesture before setting a new view.
    const damping=this.controls.enableDamping;this.controls.enableDamping=false;this.controls.update();
    this.controls.maxDistance=Math.max(350,fitted.distance*4);
    const toPosition=new THREE.Vector3(...fitted.position),toTarget=new THREE.Vector3(...fitted.target);
    if(this.smoothNextFit&&this.fitted&&this.active&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches){
      this.cameraTransition={start:performance.now(),fromPosition:this.camera.position.clone(),fromTarget:this.controls.target.clone(),toPosition,toTarget};
    }else{this.cameraTransition=null;this.controls.target.copy(toTarget);this.camera.position.copy(toPosition);}
    this.smoothNextFit=false;this.camera.far=fitted.far;this.camera.updateProjectionMatrix();
    this.camera.lookAt(this.controls.target);this.controls.update();this.controls.enableDamping=damping;
  }
  ray(clientX,clientY){const r=this.canvas.getBoundingClientRect();this.pointer.set(((clientX-r.left)/r.width)*2-1,-((clientY-r.top)/r.height)*2+1);this.raycaster.setFromCamera(this.pointer,this.camera);}
  getWorldPoint(clientX,clientY){if(!this.layout)return null;this.ray(clientX,clientY);const point=new THREE.Vector3();if(!this.raycaster.ray.intersectPlane(this.plane,point))return null;return{x:point.x+this.layout.factory.width/2,y:point.z+this.layout.factory.depth/2};}
  pointerDown(event){
    if(event.button!==0||!this.layout||!this.active)return;this.cameraTransition=null;this.canvas.focus({preventScroll:true});this.ray(event.clientX,event.clientY);
    const hit=this.raycaster.intersectObjects([...this.objects.values()].filter(object=>object.visible),true).find(h=>h.object.visible);
    let object=hit?.object;while(object&&!object.userData.assetId)object=object.parent;
    const id=object?.userData.assetId;
    if(id){this.callbacks.onSelect(id);this.select(id);}
    else{this.callbacks.onSelect(null);this.select(null);return;}
    if(this.mode==='orbit')return;
    const point=this.getWorldPoint(event.clientX,event.clientY),asset=this.layout.assets.find(a=>a.id===id);if(!point||!asset)return;
    this.drag={id,pointerId:event.pointerId,offsetX:asset.x-point.x,offsetY:asset.y-point.y,lastX:asset.x,lastY:asset.y,moved:false};this.controls.enabled=false;this.canvas.setPointerCapture(event.pointerId);this.canvas.style.cursor='grabbing';event.stopImmediatePropagation();event.preventDefault();
  }
  pointerMove(event){
    if(!this.drag||event.pointerId!==this.drag.pointerId)return;
    const p=this.getWorldPoint(event.clientX,event.clientY);if(!p)return;
    const snap=value=>this.snapStep>0?Number((Math.round(value/this.snapStep)*this.snapStep).toFixed(6)):value;
    const x=snap(p.x+this.drag.offsetX),y=snap(p.y+this.drag.offsetY);
    if(x===this.drag.lastX&&y===this.drag.lastY)return;
    this.drag.moved=true;this.drag.lastX=x;this.drag.lastY=y;this.callbacks.onMove(this.drag.id,{x,y});
  }
  pointerUp(event){if(!this.drag||event.pointerId!==this.drag.pointerId)return;const {id,moved}=this.drag;this.drag=null;this.controls.enabled=true;this.canvas.style.cursor=this.mode==='orbit'?'grab':'default';if(this.canvas.hasPointerCapture(event.pointerId))this.canvas.releasePointerCapture(event.pointerId);if(moved)this.callbacks.onMoveEnd(id);}
  dispose(){this.disposed=true;this.active=false;this.resetFrameStats();if(this.frame!==null)cancelAnimationFrame(this.frame);this.frame=null;document.removeEventListener('visibilitychange',this.visibilityChange);this.resizeObserver.disconnect();this.controls.removeEventListener('start',this.orbitStart);this.controls.dispose();this.canvas.removeEventListener('pointerdown',this.down,true);this.canvas.removeEventListener('pointermove',this.move);this.canvas.removeEventListener('pointerup',this.up);this.canvas.removeEventListener('pointercancel',this.up);this.canvas.removeEventListener('webglcontextlost',this.lost);disposeTree(this.scene);this.environmentTarget?.dispose();this.renderer.dispose();this.canvas.remove();}
}
