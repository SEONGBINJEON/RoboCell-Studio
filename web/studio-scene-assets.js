import * as THREE from './vendor/three/three.module.js';

// Procedural design proxies: visible fasteners, frames and tooling provide
// scale and legibility. These are not surveyed CAD or kinematic models.
const Y = new THREE.Vector3(0, 1, 0);
function materials() {
  const standard = (color, roughness = .45, metalness = .15, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
  return {
    shell: standard(0xcbd4d7, .38, .23), panel: standard(0x9eafb5, .44, .28), trim: standard(0x35404b, .36, .45), black: standard(0x192027, .72, .06),
    steel: standard(0xb9c4c8, .22, .88), brushed: standard(0x697982, .38, .8), yellow: standard(0xeebc21, .29, .3),
    orange: standard(0xd77724, .4, .2), teal: standard(0x327e87, .32, .25), blue: standard(0x397b9e, .42, .2),
    glass: standard(0x7699a1, .12, .1, { transparent: true, opacity: .32, depthWrite: false, side: THREE.DoubleSide }),
    screen: standard(0x142b3c, .2, .25, { emissive: 0x193b4d, emissiveIntensity: .5 }),
    led: standard(0x9fdbd4, .2, .1, { emissive: 0x6aada4, emissiveIntensity: .8 }),
    red: standard(0xa22e2c, .4, .15), green: standard(0x4b876d, .4, .1), wood: standard(0xa88a61, .92, 0),
  };
}
function mesh(parent, geometry, material, x = 0, y = 0, z = 0) {
  const object = new THREE.Mesh(geometry, material); object.position.set(x, y, z);
  object.castShadow = true; object.receiveShadow = true; parent.add(object); return object;
}
function box(parent, m, w, h, d, x = 0, y = 0, z = 0, bevel = 0) {
  let geometry;
  const r = Math.min(bevel, w * .18, h * .18, d * .18);
  if (r > .003) {
    const a = w / 2 - r, b = d / 2 - r, shape = new THREE.Shape();
    shape.moveTo(-a, -b); shape.lineTo(a, -b); shape.lineTo(a, b); shape.lineTo(-a, b); shape.closePath();
    geometry = new THREE.ExtrudeGeometry(shape, { depth: h - 2 * r, bevelEnabled: true, bevelThickness: r, bevelSize: r, bevelSegments: 2, steps: 1, curveSegments: 1 });
    geometry.rotateX(-Math.PI / 2); geometry.translate(0, -h / 2 + r, 0);
  } else geometry = new THREE.BoxGeometry(w, h, d);
  return mesh(parent, geometry, m, x, y, z);
}
function cylinder(parent, m, radius, height, x = 0, y = 0, z = 0, segments = 20, top = radius) {
  return mesh(parent, new THREE.CylinderGeometry(top, radius, height, segments), m, x, y, z);
}
function link(parent, m, a, b, width, depth = width, round = .025) {
  const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b), direction = end.clone().sub(start);
  const object = box(parent, m, width, direction.length(), depth, 0, 0, 0, round);
  object.position.copy(start.add(end).multiplyScalar(.5)); object.quaternion.setFromUnitVectors(Y, direction.normalize()); return object;
}
function pipe(parent, m, points, radius = .025) {
  return mesh(parent, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(point => new THREE.Vector3(...point))), Math.max(12, points.length * 6), radius, 6, false), m);
}
function bolts(parent, m, xs, zs, y, radius = .022) { for (const x of xs) for (const z of zs) cylinder(parent, m, radius, .017, x, y, z, 6); }
function decal(parent, value, w, h, x, y, z, color = '#d9e2e6', bg = '#293641') {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 128;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = bg; ctx.fillRect(0, 0, 512, 128);
  ctx.fillStyle = color; ctx.font = '600 56px "IBM Plex Sans KR", sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.fillText(value, 256, 66, 480);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
  return mesh(parent, new THREE.PlaneGeometry(w, h), material, x, y, z);
}
function feet(parent, m, xs, zs, height = .12) {
  for (const x of xs) for (const z of zs) {
    cylinder(parent, m.black, .085, .025, x, .013, z);
    cylinder(parent, m.steel, .025, height, x, height / 2 + .025, z);
    cylinder(parent, m.brushed, .043, .024, x, height * .65, z, 6);
  }
}

function robot(m) {
  const g = new THREE.Group();
  const baseAnchor=new THREE.Object3D();baseAnchor.name='robot-base-anchor';baseAnchor.position.y=.31;g.add(baseAnchor);
  box(g, m.trim, 1.8, .055, 1.8, 0, .0275, 0, .015);
  box(g, m.brushed, .83, .105, .76, 0, .108, 0, .018); bolts(g, m.steel, [-.32, .32], [-.28, .28], .169, .035);
  cylinder(g, m.trim, .305, .3, 0, .31, 0, 32);
  cylinder(g, m.yellow, .345, .22, 0, .55, 0, 32, .28);
  cylinder(g, m.brushed, .29, .038, 0, .676, 0, 32);
  const a = [0, .77, 0], b = [-.35, 1.51, 0], c = [.12, 2.16, 0], d = [.61, 1.83, 0];
  link(g, m.yellow, a, b, .32, .31, .065); link(g, m.yellow, b, c, .255, .265, .045);
  link(g, m.yellow, c, d, .18, .2, .032);
  for (const [index, point] of [a, b, c, d].entries()) {
    const radius = [.23, .215, .17, .12][index];
    const casing = cylinder(g, index === 0 ? m.yellow : m.trim, radius, .38 - index * .045, ...point, 28); casing.rotation.x = Math.PI / 2;
    for (const sign of [-1, 1]) {
      const cap = cylinder(g, m.brushed, radius * .71, .026, point[0], point[1], point[2] + sign * (.205 - index * .023), 24); cap.rotation.x = Math.PI / 2;
      const hub = cylinder(g, m.black, radius * .33, .031, point[0], point[1], cap.position.z + sign * .018, 20); hub.rotation.x = Math.PI / 2;
      for (let n = 0; n < 6; n++) {
        const angle = n / 6 * Math.PI * 2;
        const screw = cylinder(g, m.steel, .014, .035, point[0] + Math.cos(angle) * radius * .53, point[1] + Math.sin(angle) * radius * .53, cap.position.z + sign * .014, 6); screw.rotation.x = Math.PI / 2;
      }
    }
  }
  pipe(g, m.black, [[-.3, .49, -.23], [-.5, .97, -.3], [-.72, 1.48, -.3], [-.35, 1.95, -.28], [.11, 2.29, -.25], [.58, 1.94, -.22]], .04);
  pipe(g, m.blue, [[-.22, .55, .11], [-.42, 1.4, .13], [.12, 2.04, .13], [.56, 1.83, .09]], .018);
  box(g, m.brushed, .2, .14, .18, .64, 1.7, -.08, .012);
  box(g, m.black, .24, .12, .23, .64, 1.57, -.08, .012);
  for (const x of [.55, .73]) { box(g, m.steel, .043, .21, .085, x, 1.42, -.08); box(g, m.black, .065, .055, .09, x, 1.31, -.08); }
  box(g, m.trim, .34, .43, .18, -.47, .43, -.32, .02);
  decal(g, 'RC', .18, .065, -.42, 1.48, .1, '#25303a', '#edbc23');
  return g;
}

function cnc(m) {
  const g = new THREE.Group();
  feet(g, m, [-1.13, 1.13], [-.98, .98], .1);
  box(g, m.trim, 2.8, .22, 2.4, 0, .21, 0, .035);
  box(g, m.shell, .24, 1.95, 2.32, -1.24, 1.275, 0, .03);
  box(g, m.shell, .55, 1.95, 2.32, 1.07, 1.275, 0, .03);
  box(g, m.shell, 2.36, .14, 2.32, -.03, 2.22, 0, .025);
  box(g, m.trim, 2.4, 1.8, .14, 0, 1.25, -1.09, .012);
  // Recessed service panels and screw lines break up large sheet-metal faces.
  for(const side of [-1,1]){
    box(g,m.trim,.018,1.55,1.94,side*1.365,1.25,-.07,.006);
    box(g,m.panel,.025,1.49,1.88,side*1.378,1.25,-.07,.009);
    box(g,m.brushed,.026,.014,1.82,side*1.393,1.56,-.07);
    for(const z of [-.87,.73])for(const y of [.57,1.92]){const screw=cylinder(g,m.steel,.018,.028,side*1.397,y,z,6);screw.rotation.z=Math.PI/2;}
    for(let n=0;n<7;n++)box(g,m.trim,.03,.018,.49,side*1.397,.64+n*.065,-.5);
  }
  box(g,m.panel,1.95,1.36,.024,0,1.22,-1.171,.014);
  for(let n=0;n<8;n++)box(g,m.trim,1.5,.02,.026,0,.76+n*.065,-1.189);
  box(g, m.shell, 1.96, .48, .2, -.2, .55, 1.02, .02);
  box(g, m.brushed, 1.74, .16, 1.82, -.23, .53, -.02, .014);
  // Work chamber: linear ways, T-slot table, spindle and a held workpiece.
  for (const x of [-.72, .24]) box(g, m.steel, .09, .075, 1.22, x, .72, -.13);
  box(g, m.trim, 1.4, .17, .9, -.25, .83, -.14, .02);
  for (let n = 0; n < 7; n++) box(g, m.steel, 1.28, .025, .063, -.25, .93, -.47 + n * .105);
  box(g, m.brushed, .37, .2, .27, -.3, 1.05, -.12, .018);
  box(g, m.shell, .52, .86, .55, -.25, 1.78, -.4, .03);
  cylinder(g, m.brushed, .15, .2, -.25, 1.31, -.22, 24); cylinder(g, m.steel, .055, .18, -.25, 1.13, -.22, 16);
  box(g, m.led, .65, .025, .045, -.3, 2.08, .55);
  // Separate sliding doors with transparent inspection windows.
  for (const x of [-.69, .2]) {
    box(g, m.brushed, .85, 1.42, .035, x, 1.46, 1.105, .01);
    box(g, m.trim, .7, 1.13, .045, x, 1.52, 1.13, .01);
    box(g, m.glass, .64, 1.07, .022, x, 1.52, 1.16);
    // The dark frame is open in the central window, with the translucent pane above.
    const framing = g.children[g.children.length - 2]; g.remove(framing); framing.geometry.dispose();
    const panel = g.children[g.children.length - 2]; g.remove(panel); panel.geometry.dispose();
    for (const side of [-1, 1]) box(g, m.brushed, .075, 1.42, .06, x + side * .385, 1.46, 1.13);
    for (const side of [-1, 1]) box(g, m.brushed, .85, .13, .06, x, 1.46 + side * .645, 1.13);
    box(g, m.black, .043, .38, .09, x + .26, 1.35, 1.17, .01);
  }
  box(g, m.yellow, 2.55, .045, .025, 0, 2.13, 1.18);
  box(g, m.trim, .44, .85, .16, 1.085, 1.49, 1.105, .025);
  box(g, m.screen, .32, .31, .022, 1.085, 1.68, 1.195, .007);
  for (let n = 0; n < 5; n++) box(g, n === 0 ? m.led : m.brushed, .21 - n * .021, .013, .007, 1.055, 1.76 - n * .04, 1.21);
  for (const x of [1, 1.085, 1.17]) for (const y of [1.28, 1.36, 1.44]) {
    const key = cylinder(g, m.brushed, .023, .012, x, y, 1.205, 12); key.rotation.x = Math.PI / 2;
  }
  const stop = cylinder(g, m.red, .038, .024, 1.085, 1.14, 1.205, 16); stop.rotation.x = Math.PI / 2;
  for (let n = 0; n < 9; n++) box(g, m.black, .29, .016, .012, 1.065, .53 + n * .035, 1.166);
  cylinder(g, m.trim, .025, .12, 1.05, 2.35, -.64, 12);
  cylinder(g, m.orange, .055, .055, 1.05, 2.435, -.64, 16); cylinder(g, m.green, .055, .045, 1.05, 2.485, -.64, 16);
  decal(g, 'ROBOCELL / CNC', .62, .12, -.78, 2.22, 1.178);
  return g;
}

function conveyor(m, length = 4, depth = .9) {
  const g = new THREE.Group(), z = depth / 2 - .05;
  feet(g, m, [-length / 2 + .3, length / 2 - .3], [-z + .055, z - .055], .08);
  for (const x of [-length / 2 + .3, length / 2 - .3]) for (const sign of [-1, 1]) box(g, m.brushed, .07, .59, .07, x, .385, sign * (z - .055));
  for (const sign of [-1, 1]) {
    box(g, m.brushed, length, .16, .065, 0, .68, sign * z, .012);
    box(g, m.shell, length, .032, .055, 0, .79, sign * z);
    box(g, m.trim, length - .28, .05, .045, 0, .3, sign * (z - .055));
    for (const x of [-length / 2 + .3, length / 2 - .3]) { const screw = cylinder(g, m.steel, .018, .075, x, .68, sign * z, 6); screw.rotation.x = Math.PI / 2; }
  }
  for (let x = -length / 2 + .075; x <= length / 2 - .04; x += .14) {
    const roller = cylinder(g, m.steel, .046, depth - .13, x, .755, 0, 14); roller.rotation.x = Math.PI / 2;
  }
  for (const x of [-length / 2 + .3, length / 2 - .3]) { box(g, m.brushed, .07, .07, depth - .08, x, .31, 0); }
  const motor = cylinder(g, m.blue, .11, .32, length / 2 - .39, .48, z - .13, 16); motor.rotation.x = Math.PI / 2;
  for (let n = 0; n < 6; n++) box(g, m.brushed, .2, .015, .025, length / 2 - .39, .53 + n * .009, z - .29);
  box(g, m.trim, .22, .16, .16, length / 2 - .56, .6, z - .16, .01);
  for (const x of [-length / 2 + .17, length / 2 - .17]) box(g, m.yellow, .1, .08, depth, x, .72, 0);
  box(g, m.black, .34, .06, .36, -.45, .83, 0, .008); cylinder(g, m.brushed, .12, .1, -.45, .91, 0);
  return g;
}
function workstation(m, width, depth, top = .78) {
  const g = new THREE.Group(); feet(g, m, [-width / 2 + .09, width / 2 - .09], [-depth / 2 + .09, depth / 2 - .09], .075);
  for (const x of [-width / 2 + .09, width / 2 - .09]) for (const z of [-depth / 2 + .09, depth / 2 - .09]) box(g, m.brushed, .06, top - .09, .06, x, (top + .09) / 2, z);
  box(g, m.trim, width - .1, .04, depth - .1, 0, .23, 0);
  box(g, m.shell, width, .09, depth, 0, top, 0, .018);
  return g;
}
function inspection(m) {
  const g = workstation(m, 1.7, 1.4, .83);
  box(g, m.teal, .96, .04, .78, 0, .9, 0);
  for (const x of [-.67, .67]) { box(g, m.brushed, .065, 1.19, .065, x, 1.47, -.52); box(g, m.black, .09, .03, .09, x, 1.97, -.52); }
  box(g, m.brushed, 1.4, .075, .075, 0, 2.055, -.52);
  box(g, m.trim, .09, .06, .6, 0, 2.055, -.2);
  cylinder(g, m.trim, .085, .22, 0, 1.9, .055, 20); cylinder(g, m.black, .065, .09, 0, 1.745, .055, 20);
  const ring = mesh(g, new THREE.TorusGeometry(.145, .02, 8, 24), m.led, 0, 1.72, .055); ring.rotation.x = Math.PI / 2;
  box(g, m.brushed, .33, .045, .26, 0, .95, .06, .008);
  cylinder(g, m.steel, .09, .09, 0, 1.01, .06);
  box(g, m.trim, .35, .28, .07, .58, 1.15, .45, .02); box(g, m.screen, .29, .21, .012, .58, 1.16, .492);
  pipe(g, m.black, [[0, 2.04, -.42], [.58, 2.05, -.53], [.7, 1.64, -.53], [.7, .65, -.53]], .018);
  decal(g, 'VISION', .31, .07, -.48, .83, .707); return g;
}
function buffer(m) {
  const g = workstation(m, 1.5, 1.2, .67);
  for (const x of [-.45, 0, .45]) for (const z of [-.29, .29]) {
    box(g, m.blue, .4, .14, .46, x, .78, z, .025);
    box(g, m.black, .33, .018, .38, x, .86, z, .005);
    for (const dx of [-.08, .08]) cylinder(g, m.steel, .057, .075, x + dx, .905, z, 16);
  }
  for (const x of [-.42, .42]) box(g, m.wood, .43, .2, .61, x, .37, -.1, .012);
  decal(g, 'PARTS', .28, .07, -.49, .67, .607); return g;
}
function fence(g, m, a, b) {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]), count = Math.ceil(length / 1.5), points = [];
  const point = (t, y) => [a[0] + (b[0] - a[0]) * t, y, a[1] + (b[1] - a[1]) * t];
  for (let n = 0; n <= count; n++) {
    const p = point(n / count, .88); box(g, m.yellow, .06, 1.7, .06, ...p, .008); box(g, m.trim, .16, .03, .16, p[0], .035, p[2]);
  }
  for (const y of [.22, 1.7]) link(g, m.trim, point(0, y), point(1, y), .036, .036, .005);
  for (let x = .12; x < length; x += .12) points.push(...point(x / length, .24), ...point(x / length, 1.68));
  for (let y = .24; y <= 1.68; y += .13) points.push(...point(0, y), ...point(1, y));
  const wire = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(points, 3)), new THREE.LineBasicMaterial({ color: 0x58646a, transparent: true, opacity: .65 })); wire.raycast = () => {}; g.add(wire);
}
function robotCell(m) {
  const g = new THREE.Group(); box(g, m.trim, 11.6, .035, 3.4, 0, .0175, 0);
  const belt = conveyor(m, 7.5, .78); belt.position.set(-1.25, .04, .95); g.add(belt);
  const machine = cnc(m); machine.scale.set(.8, 1, .72); machine.position.set(-1.25, .04, -.63); g.add(machine);
  // Robot base uses the same cell-local (+3.8, +0.6) anchor as the adapter.
  const arm = robot(m); arm.position.set(3.8, .04, .6); arm.rotation.y = Math.PI; arm.scale.setScalar(.94); g.add(arm);
  const check = inspection(m); check.scale.set(.64, .91, .65); check.position.set(4.91, .04, -.65); g.add(check);
  const stock = buffer(m); stock.position.set(-4.9, .04, -.7); stock.scale.set(.95, 1, .8); g.add(stock);
  fence(g, m, [-5.68, -1.62], [5.68, -1.62]); fence(g, m, [5.68, -1.62], [5.68, 1.62]);
  for (const z of [-1.66, 1.66]) box(g, m.yellow, 11.5, .008, .042, 0, .047, z);
  for (let x = -5.48; x < 5.5; x += .38) { const dash = box(g, m.yellow, .18, .009, .18, x, .05, 1.51); dash.rotation.y = -.5; }
  return g;
}

// Merge each asset's static solids by material. Fasteners and rollers then add
// geometry detail without one draw call per component. Assets remain separate
// selectable roots; transparent windows keep their own material batch.
function batchSolids(root) {
  root.updateMatrixWorld(true); const batches = new Map(), meshes = [];
  root.traverse(object => { if (object.isMesh && !Array.isArray(object.material)) { const list = batches.get(object.material) || []; list.push(object); batches.set(object.material, list); meshes.push(object); } });
  for (const [material, objects] of batches) {
    const positions = [], normals = [], uvs = [], normalMatrix = new THREE.Matrix3(), p = new THREE.Vector3(), n = new THREE.Vector3();
    for (const object of objects) {
      const geometry = object.geometry, index = geometry.index, count = index ? index.count : geometry.attributes.position.count;
      normalMatrix.getNormalMatrix(object.matrixWorld);
      for (let i = 0; i < count; i++) {
        const at = index ? index.getX(i) : i;
        p.fromBufferAttribute(geometry.attributes.position, at).applyMatrix4(object.matrixWorld); positions.push(p.x, p.y, p.z);
        if (geometry.attributes.normal) n.fromBufferAttribute(geometry.attributes.normal, at).applyMatrix3(normalMatrix).normalize(); else n.set(0, 1, 0);
        normals.push(n.x, n.y, n.z); const uv = geometry.attributes.uv; uvs.push(uv ? uv.getX(at) : 0, uv ? uv.getY(at) : 0);
      }
    }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3)); geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.computeBoundingBox(); geometry.computeBoundingSphere(); const combined = new THREE.Mesh(geometry, material);
    combined.castShadow = !material.transparent; combined.receiveShadow = true; root.add(combined);
  }
  for (const object of meshes) { object.removeFromParent(); object.geometry.dispose(); }
  return root;
}

export function buildEngineeringAsset(asset, dimensions) {
  const m = materials(), g = ({ robot, cnc, conveyor, inspection, buffer, 'robot-cell': robotCell }[asset.type] || buffer)(m);
  batchSolids(g);
  // Give the model exactly the declared envelope, including small protrusions.
  // Root layout transforms remain the only source of placement and rotation.
  const bounds = new THREE.Box3().setFromObject(g), size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
  const contents = new THREE.Group(); contents.add(...[...g.children]); contents.position.set(-center.x, -bounds.min.y, -center.z); g.add(contents);
  g.scale.set(dimensions.width / size.x, dimensions.height / size.y, dimensions.depth / size.z);
  // Bake the normalization so FactoryScene can apply edited dimensions once.
  g.updateMatrixWorld(true); const normalized = new THREE.Group(); normalized.add(g); batchSolids(normalized);
  const used = new Set(); normalized.traverse(object => { if (object.material) used.add(object.material); });
  for (const material of Object.values(m)) if (!used.has(material)) material.dispose();
  return normalized;
}
