// Perspective fitting for the web layout preview, independent of WebGL/DOM.
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalized = vector => {
  const length = Math.hypot(...vector);
  if (!Number.isFinite(length) || length < 1e-10) throw new Error('A camera direction is required.');
  return vector.map(value => value / length);
};

export function boxCorners(min, max) {
  return [0, 1].flatMap(x => [0, 1].flatMap(y => [0, 1].map(z => [
    x ? max[0] : min[0], y ? max[1] : min[1], z ? max[2] : min[2],
  ])));
}

/** Fit every bounding-box corner inside the perspective frustum, with margin.
 * direction points from the target toward the camera; y is the world up axis.
 * Invalid/hidden viewport sizes are rejected so callers retain the last camera.
 */
export function fitPerspectiveBox({ min, max, direction, fovDegrees, aspect, padding = 1.12, near = 0.1 }) {
  if (![min, max, direction].every(v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)) ||
      min.some((value, i) => value > max[i]) || !Number.isFinite(aspect) || aspect <= 0 ||
      !Number.isFinite(fovDegrees) || fovDegrees <= 0 || fovDegrees >= 179 ||
      !Number.isFinite(padding) || padding < 1 || !Number.isFinite(near) || near <= 0) {
    throw new Error('Valid bounds, field of view and visible viewport dimensions are required.');
  }
  const target = min.map((value, i) => (value + max[i]) / 2);
  const backward = normalized(direction);
  // Near-vertical views need a stable right vector; this is equivalent to a
  // camera looking straight down with the top of the image toward negative Z.
  const right = normalized(Math.abs(backward[1]) > 1 - 1e-10 ? [1, 0, 0] : cross([0, 1, 0], backward));
  const up = normalized(cross(backward, right));
  const tanVertical = Math.tan(fovDegrees * Math.PI / 360);
  const tanHorizontal = tanVertical * aspect;
  let distance = near * 2;
  let furthestDepth = 0;
  for (const corner of boxCorners(min, max)) {
    const offset = corner.map((value, i) => value - target[i]);
    const towardCamera = dot(offset, backward);
    distance = Math.max(distance,
      towardCamera + Math.abs(dot(offset, right)) * padding / tanHorizontal,
      towardCamera + Math.abs(dot(offset, up)) * padding / tanVertical,
      towardCamera + near * 2);
    furthestDepth = Math.max(furthestDepth, -towardCamera);
  }
  return {
    target, position: target.map((value, i) => value + backward[i] * distance),
    distance, far: Math.max(1000, (distance + furthestDepth) * 2),
    right, up, backward,
  };
}

/** Fit actual vertices, without inventing corners in the scene's enclosing box.
 * For a fixed view direction each vertex places a lower/upper bound on camera
 * X and Y. Their intersection gives the closest possible camera and a balanced
 * target, while preserving a margin around every projected point.
 */
export function fitPerspectivePoints({points,direction,fovDegrees,aspect,padding=1.07,near=.1}){
  if(!Array.isArray(points)||points.length===0||!points.every(p=>Array.isArray(p)&&p.length===3&&p.every(Number.isFinite))||
    !Array.isArray(direction)||direction.length!==3||!direction.every(Number.isFinite)||!Number.isFinite(aspect)||aspect<=0||
    !Number.isFinite(fovDegrees)||fovDegrees<=0||fovDegrees>=179||!Number.isFinite(padding)||padding<1||!Number.isFinite(near)||near<=0){
    throw new Error('Visible points, field of view and viewport dimensions are required.');
  }
  const backward=normalized(direction),right=normalized(Math.abs(backward[1])>1-1e-10?[1,0,0]:cross([0,1,0],backward)),up=normalized(cross(backward,right));
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(const point of points)for(let i=0;i<3;i++){min[i]=Math.min(min[i],point[i]);max[i]=Math.max(max[i],point[i]);}
  const origin=min.map((n,i)=>(n+max[i])/2),tanV=Math.tan(fovDegrees*Math.PI/360)/padding,tanH=tanV*aspect;
  let xLower=-Infinity,xUpper=Infinity,yLower=-Infinity,yUpper=Infinity,zMin=Infinity,zMax=-Infinity;
  for(const point of points){
    const offset=point.map((n,i)=>n-origin[i]),x=dot(offset,right),y=dot(offset,up),z=dot(offset,backward);
    xLower=Math.max(xLower,x+tanH*z);xUpper=Math.min(xUpper,x-tanH*z);
    yLower=Math.max(yLower,y+tanV*z);yUpper=Math.min(yUpper,y-tanV*z);
    zMin=Math.min(zMin,z);zMax=Math.max(zMax,z);
  }
  const distance=Math.max((xLower-xUpper)/(2*tanH),(yLower-yUpper)/(2*tanV),zMax+near*2);
  const x=(xLower+xUpper)/2,y=(yLower+yUpper)/2;
  const target=origin.map((n,i)=>n+right[i]*x+up[i]*y);
  return{target,position:target.map((n,i)=>n+backward[i]*distance),distance,far:Math.max(1000,(distance-zMin)*2),right,up,backward};
}
