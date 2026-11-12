import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultLayout } from '../web/studio-model.js';
import { robotPlanAnchor, distanceToFootprint, analyzePlanningSafety, normalizeSafetySettings } from '../web/studio-safety.js';
test('unknown reach remains unassessed, never an inferred safe result',()=>{
  const result = analyzePlanningSafety(createDefaultLayout());
  assert.equal(result.status,'not_assessed'); assert.equal(result.radius,null); assert.equal(result.envelopes.length,0); assert.ok(result.issues.length);
  for(const radius of [-1,0,Infinity,NaN,21]) assert.throws(()=>normalizeSafetySettings({radius}));
});
test('cell robot anchor matches scaled and rotated renderer coordinates',()=>{
  const cell = createDefaultLayout().assets.find(a=>a.type==='robot-cell'); cell.x=12;cell.y=10;cell.rotation=90;
  const anchor=robotPlanAnchor(cell); assert.ok(Math.abs(anchor.x-11.4)<1e-9); assert.ok(Math.abs(anchor.y-13.8)<1e-9);
  cell.width*=2;cell.depth*=2;const scaled=robotPlanAnchor(cell);assert.ok(Math.abs(scaled.x-10.8)<1e-9);assert.ok(Math.abs(scaled.y-17.6)<1e-9);
});
test('rotated footprint distance includes containment and tangency',()=>{
 const zone={x:0,y:0,width:4,depth:2,rotation:90};assert.equal(distanceToFootprint({x:0,y:0},zone),0);assert.ok(Math.abs(distanceToFootprint({x:3,y:0},zone)-2)<1e-9);
 const layout=createDefaultLayout();layout.assets=[{...layout.assets[0],type:'robot',x:5,y:5,width:1.8,depth:1.8,rotation:0},{...layout.assets[1],type:'worker-zone',x:8,y:5,width:2,depth:2,rotation:0}];
 const result=analyzePlanningSafety(layout,{radius:2,source:'example'});assert.equal(result.envelopes[0].overlaps.length,1);assert.equal(result.status,'not_assessed');assert.equal(result.source,'example');
});
