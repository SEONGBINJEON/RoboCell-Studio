import test from 'node:test';
import assert from 'node:assert/strict';
import { boxCorners, fitPerspectiveBox, fitPerspectivePoints } from '../web/studio-scene-math.js';

const dot=(a,b)=>a.reduce((sum,n,i)=>sum+n*b[i],0);
test('all bounds remain inside the perspective frustum in top/front/3D on narrow and wide screens',()=>{
  for(const [width,depth,height] of [[24,18,6],[80,8,6],[200,4,30],[4,200,2],[4,4,30]]) {
    // Includes space outside the hall for wall thickness and dimension labels.
    const min=[-width/2-1.5,-1.5,-depth/2-1.5],max=[width/2+3, height+2, depth/2+3];
    for(const aspect of [.35,.5,1,2.4]) for(const direction of [[0,1,.0001],[0,.34,.94],[.62,.68,.78]]) {
      const fit=fitPerspectiveBox({min,max,aspect,direction,fovDegrees:39});
      for(const corner of boxCorners(min,max)){
        const offset=corner.map((n,i)=>n-fit.target[i]);
        const depthToCamera=fit.distance-dot(offset,fit.backward);
        assert.ok(depthToCamera>.1);
        assert.ok(depthToCamera<fit.far);
        const normalizedX=dot(offset,fit.right)/(depthToCamera*Math.tan(39*Math.PI/360)*aspect);
        const normalizedY=dot(offset,fit.up)/(depthToCamera*Math.tan(39*Math.PI/360));
        assert.ok(Math.abs(normalizedX)<=1/1.12+1e-9,`clipped X: ${[width,depth,height,aspect,direction]}`);
        assert.ok(Math.abs(normalizedY)<=1/1.12+1e-9,`clipped Y: ${[width,depth,height,aspect,direction]}`);
      }
    }
  }
});

test('translation of the layout translates camera and target without changing fit distance',()=>{
  const args={min:[-12,0,-9],max:[12,7,9],direction:[.62,.68,.78],aspect:.8,fovDegrees:39};
  const shift=[480,12,-330],a=fitPerspectiveBox(args),b=fitPerspectiveBox({...args,min:args.min.map((v,i)=>v+shift[i]),max:args.max.map((v,i)=>v+shift[i])});
  assert.equal(a.distance,b.distance);
  assert.deepEqual(b.target,a.target.map((n,i)=>n+shift[i]));
  for(let i=0;i<3;i++)assert.ok(Math.abs(b.position[i]-a.position[i]-shift[i])<1e-10);
});

test('exact top-down direction is finite and keeps camera-facing labels within a provided bound',()=>{
  const fit=fitPerspectiveBox({min:[-12,-.2,-9],max:[15,9,12],direction:[0,1,0],aspect:.5,fovDegrees:39});
  assert.ok(fit.position.every(Number.isFinite));
  assert.deepEqual(fit.right,[1,0,0]);
  assert.deepEqual(fit.up,[0,0,-1]);
});

test('zero/hidden viewport and invalid bounds cannot replace the last valid framing',()=>{
  const args={min:[-12,0,-9],max:[12,7,9],direction:[0,1,.0001],aspect:1,fovDegrees:39};
  for(const change of [{aspect:0},{aspect:NaN},{fovDegrees:0},{min:[13,0,0]},{direction:[0,0,0]}])assert.throws(()=>fitPerspectiveBox({...args,...change}));
});

test('point fit centers the actual visible geometry and does not reserve phantom bounding-box corners',()=>{
  const points=[...boxCorners([-12,-.2,-9],[12,0,9]),[-12,6,-9],[-12,6,9],[12,6,-9],[12,6,9],[-13.5,7,-9],[15,0,0],[0,0,12]];
  for(const direction of [[0,1,.0001],[0,.34,.94],[.62,.5,.78]])for(const aspect of [.35,.5,1,790/470,2.4]){
    const fit=fitPerspectivePoints({points,direction,aspect,fovDegrees:39,padding:1.07});
    for(const p of points){
      const offset=p.map((n,i)=>n-fit.target[i]),depth=fit.distance-dot(offset,fit.backward);
      assert.ok(depth>.1);assert.ok(depth<fit.far);
      assert.ok(Math.abs(dot(offset,fit.right)/(depth*Math.tan(39*Math.PI/360)*aspect))<=1/1.07+1e-9);
      assert.ok(Math.abs(dot(offset,fit.up)/(depth*Math.tan(39*Math.PI/360)))<=1/1.07+1e-9);
    }
  }
  const options={direction:[.62,.5,.78],aspect:790/470,fovDegrees:39,padding:1.07};
  const exact=fitPerspectivePoints({...options,points}),box=fitPerspectiveBox({...options,min:[-13.5,-.2,-9],max:[15,7,12]});
  assert.ok(exact.distance<box.distance*.8,'fitting unused high/far corners must not make the real scene tiny');
});

test('point fitting is translation invariant and rejects empty or malformed geometry',()=>{
  const points=[[0,0,0],[10,0,0],[10,0,8],[2,5,3]],options={points,direction:[.62,.5,.78],aspect:1.4,fovDegrees:39};
  const shift=[-480,12,330],a=fitPerspectivePoints(options),b=fitPerspectivePoints({...options,points:points.map(p=>p.map((n,i)=>n+shift[i]))});
  assert.ok(Math.abs(a.distance-b.distance)<1e-10);
  for(let i=0;i<3;i++){assert.ok(Math.abs(b.position[i]-a.position[i]-shift[i])<1e-10);assert.ok(Math.abs(b.target[i]-a.target[i]-shift[i])<1e-10);}
  for(const change of [{points:[]},{points:[[0,NaN,0]]},{direction:[0,0,0]},{aspect:0},{padding:.9}])assert.throws(()=>fitPerspectivePoints({...options,...change}));
});
