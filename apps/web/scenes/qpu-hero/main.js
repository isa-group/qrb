// QPU diorama: an exploded dilution-refrigerator chandelier drawn as coloured glyphs.
// Five gold cryostat plates step diagonally down toward the camera, joined by coiled coax;
// the mixing-chamber plate carries the sample holder and a 4x4 transmon chip.
// Everything is procedural (geometry and canvas-drawn textures). Runs live and loops.
// mount(container) draws it into any element; standalone.js mounts it full window.
// Append ?t=<seconds> to the standalone URL to freeze a single moment.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const W = 1440, HH = 1440, DURATION = 24; // canvas size; DURATION is one camera sweep in seconds
const COLS = 200, ROWS = 100;
const CLS = { plate: 1, cable: 2, chip: 3, qubit: 4, bg: 5 };

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const fract = x => x - Math.floor(x);
const hash2 = (x, y) => fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);
function vnoise(x, y) {
  const i = Math.floor(x), j = Math.floor(y), f = x - i, g = y - j, u = f * f * (3 - 2 * f), v = g * g * (3 - 2 * g);
  return (hash2(i, j) * (1 - u) + hash2(i + 1, j) * u) * (1 - v) + (hash2(i, j + 1) * (1 - u) + hash2(i + 1, j + 1) * u) * v;
}
let seed = 23;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const V2 = (x, y) => new THREE.Vector2(x, y);

const time = { value: 0 };
function tag(mat, cls, extra) {
  mat.onBeforeCompile = (s) => {
    extra?.(s);
    s.fragmentShader = s.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>\n gl_FragColor.a = ${(cls / 16).toFixed(4)};`);
  };
  mat.customProgramCacheKey = () => `c${cls}${extra ? extra.toString().length : 0}`;
  return mat;
}
function canvasTex(w, h, draw, rx = 1, ry = 1) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx, ry); t.anisotropy = 8;
  return t;
}

// ---------- procedural textures ----------
// Brushed gold: concentric lathe marks, three engraved rings and a chamfered rim (greyscale, tinted by the material).
const goldTex = () => canvasTex(512, 512, (x, w, h) => {
  const im = x.createImageData(w, h), d = im.data;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const u = (i + .5) / w * 2 - 1, v = (j + .5) / h * 2 - 1, r = Math.hypot(u, v), a = Math.atan2(v, u);
    let k = .8 + (hash2(Math.floor(r * 300), 3.1) - .5) * .3 + (vnoise(r * 22, a * 3 + 7) - .5) * .24;
    for (const R of [.3, .58, .84]) k *= 1 - .5 * Math.exp(-(((r - R) * 150) ** 2));
    k *= 1 - .45 * sstep(.95, 1, r);
    const o = (j * w + i) * 4, g = 255 * clamp(k);
    d[o] = g; d[o + 1] = g; d[o + 2] = g; d[o + 3] = 255;
  }
  x.putImageData(im, 0, 0);
});
// Silicon die: violet substrate, a feedline loop, meandered readout resonators and couplers.
const QN = 4, QPITCH = .62, CHIP = 3.0;
const chipTex = () => canvasTex(1024, 1024, (x, w) => {
  x.fillStyle = '#16124a'; x.fillRect(0, 0, w, w);
  for (let i = 0; i < 2600; i++) { x.fillStyle = `rgba(150,140,255,${rnd() * .06})`; x.fillRect(rnd() * w, rnd() * w, 3, 3); }
  const s = w / CHIP, q = (k) => w / 2 + (k - (QN - 1) / 2) * QPITCH * s;
  x.lineCap = 'round'; x.lineJoin = 'round';
  x.strokeStyle = '#5a52b4'; x.lineWidth = 14;
  x.strokeRect(70, 70, w - 140, w - 140);
  x.strokeStyle = '#3c3592'; x.lineWidth = 5;
  for (let a = 0; a < QN; a++) for (let b = 0; b < QN; b++) {
    const cx = q(a) + 52, cy = q(b) + 52; // meander between qubits
    x.beginPath(); x.moveTo(q(a) + 22, q(b) + 22);
    for (let m = 0; m < 6; m++) x.lineTo(cx + (m % 2 ? 26 : -26), cy - 30 + m * 12);
    x.stroke();
  }
  x.strokeStyle = '#6a62c6'; x.lineWidth = 7;
  for (let a = 0; a < QN; a++) for (let b = 0; b < QN; b++) {
    if (a < QN - 1) { x.beginPath(); x.moveTo(q(a) + 40, q(b)); x.lineTo(q(a + 1) - 40, q(b)); x.stroke(); }
    if (b < QN - 1) { x.beginPath(); x.moveTo(q(a), q(b) + 40); x.lineTo(q(a), q(b + 1) - 40); x.stroke(); }
  }
  x.fillStyle = '#d9b25a';
  for (let k = 0; k < 40; k++) { const p = 30 + (k % 10) * ((w - 60) / 9), e = k / 10 | 0; const [px, py] = [[p, 18], [p, w - 18], [18, p], [w - 18, p]][e]; x.fillRect(px - 14, py - 14, 28, 28); }
});
// Sample-holder board: dark laminate with gold launch traces fanning in to the die.
const pcbTex = () => canvasTex(512, 512, (x, w) => {
  x.fillStyle = '#1c4743'; x.fillRect(0, 0, w, w);
  x.strokeStyle = '#d4a347'; x.lineWidth = 5;
  for (let k = 0; k < 12; k++) {
    const p = w * (.2 + .6 * (k % 3) / 2), e = k / 3 | 0, inner = w * .5 + (p - w * .5) * .45;
    const pts = [[[p, 6], [inner, w * .33]], [[p, w - 6], [inner, w * .67]], [[6, p], [w * .33, inner]], [[w - 6, p], [w * .67, inner]]][e];
    x.beginPath(); x.moveTo(...pts[0]); x.lineTo(...pts[1]); x.stroke();
  }
  x.fillStyle = '#e1b65a';
  for (let i = 0; i < 60; i++) { x.beginPath(); x.arc(20 + rnd() * (w - 40), 20 + rnd() * (w - 40), 4, 0, 7); x.fill(); }
});
const floorTex = () => canvasTex(128, 128, (x, w) => {
  x.fillStyle = '#160f26'; x.fillRect(0, 0, w, w);
  x.fillStyle = '#33264f'; x.fillRect(0, 0, w, 3); x.fillRect(0, 0, 3, w);
  x.fillStyle = '#4f3b72'; x.fillRect(0, 0, 9, 3); x.fillRect(0, 0, 3, 9);
}, 300, 300);

// ---------- layout: the classic hanging chandelier, plates shrinking toward the chip ----------
// Plates are concentric on the y axis; the chip hangs below the MXC plate on a cold finger.
const PT = .85, GAP = 5;
const PLATES = [7.6, 6.3, 5.1, 4.0, 3.0].map((r, i) => ({ r, c: new THREE.Vector3(0, 4.4 + (4 - i) * GAP, 0) }));
const MXC = PLATES[4], MXC_TOP = MXC.c.y + PT / 2, MXC_BOT = MXC.c.y - PT / 2;
const CHIP_POS = new THREE.Vector3(0, 0, .6), CHIP_TILT = THREE.MathUtils.degToRad(58), CHIP_SCALE = .6;
const FLOOR_Y = -10;

// Where coils and posts cross each gap: rings just inside the smaller, lower plate's rim.
function gapPoints(i) {
  const b = PLATES[i + 1], coils = [], posts = [];
  for (let k = 0; k < 4; k++) { const a = (k + .5) / 4 * Math.PI * 2; posts.push(V2(Math.cos(a) * (b.r - .3), Math.sin(a) * (b.r - .3))); }
  for (const [rr, sp, off] of [[b.r - .55, 1.0, 0]]) {
    const n = Math.floor(2 * Math.PI * rr / sp);
    for (let k = 0; k < n; k++) {
      const ang = (k + off) / n * Math.PI * 2, p = V2(Math.cos(ang) * rr, Math.sin(ang) * rr);
      if (rr > 1.3 && posts.every(q => q.distanceTo(p) > .6)) coils.push(p);
    }
  }
  return { coils, posts };
}
const GAPS = PLATES.slice(0, -1).map((_, i) => gapPoints(i));

// ---------- materials ----------
const GOLD = new THREE.Color('#d6ab4c');
let goldMap;
const goldMat = (tint = GOLD) => tag(new THREE.MeshPhongMaterial({ color: tint, map: goldMap, specular: new THREE.Color('#ffdf9a'), shininess: 38 }), CLS.plate);
const pulseExtra = (s) => {
  s.uniforms.uTime = time;
  s.vertexShader = 'attribute float aAlong; attribute float aPhase; varying float vAlong; varying float vPhase;\n' +
    s.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vAlong = aAlong; vPhase = aPhase;');
  s.fragmentShader = 'uniform float uTime; varying float vAlong; varying float vPhase;\n' +
    s.fragmentShader.replace('#include <dithering_fragment>', `
      float pz = fract(vAlong * 1.6 - uTime * .3 + vPhase);
      float pulse = smoothstep(0., .03, pz) * smoothstep(.11, .03, pz);
      gl_FragColor.rgb += vec3(.8, .4, 1.) * pulse * 1.5;
      #include <dithering_fragment>`);
};

// ---------- builders ----------
function buildPlates(scene) {
  goldMap = goldTex();
  const bolts = [], holes = [], cans = [];
  PLATES.forEach(({ r, c }, i) => {
    const tint = GOLD.clone().offsetHSL(-.008 * i, 0, .015 * i);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, PT, 128), goldMat(tint));
    m.position.copy(c); m.castShadow = m.receiveShadow = true; scene.add(m);
    const lip = new THREE.Mesh(new THREE.TorusGeometry(r - .12, .07, 6, 128), goldMat(tint.clone().multiplyScalar(.8)));
    lip.rotation.x = -Math.PI / 2; lip.position.set(c.x, c.y + PT / 2, c.z); lip.castShadow = true; scene.add(lip);
    const n = Math.round(2 * Math.PI * (r - .38) / .42);
    for (let k = 0; k < n; k++) { const a = k / n * Math.PI * 2; bolts.push([c.x + Math.cos(a) * (r - .38), c.y + PT / 2, c.z + Math.sin(a) * (r - .38)]); }
    const avoid = [...(GAPS[i]?.coils ?? []), ...(GAPS[i - 1]?.coils ?? [])];
    const clear = (x, z, d) => avoid.every(p => (p.x - x) ** 2 + (p.y - z) ** 2 > d * d) && Math.hypot(x - c.x, z - c.z) > 1.5;
    for (let k = 0; k < 40; k++) {
      const a = rnd() * 6.283, rr = (.25 + .65 * Math.sqrt(rnd())) * (r - .8), x = c.x + Math.cos(a) * rr, z = c.z + Math.sin(a) * rr;
      if (clear(x, z, .7)) holes.push([x, c.y + PT / 2 + .005, z, rnd() < .3 ? .28 + rnd() * .22 : .08 + rnd() * .1]);
    }
    for (let k = 0, tries = 0; k < 3 && tries < 60; tries++) {
      const a = rnd() * 6.283, rr = rnd() * (r - 1.6), x = c.x + Math.cos(a) * rr, z = c.z + Math.sin(a) * rr;
      if (!clear(x, z, 1.2)) continue;
      cans.push([x, c.y + PT / 2, z, .45 + rnd() * .5, .5 + rnd() * .9]); k++;
    }
  });
  const o = new THREE.Object3D();
  const bm = new THREE.InstancedMesh(new THREE.CylinderGeometry(.1, .1, .1, 8), goldMat(new THREE.Color('#f4cf7a')), bolts.length);
  bolts.forEach(([x, y, z], k) => { o.position.set(x, y + .05, z); o.scale.setScalar(1); o.updateMatrix(); bm.setMatrixAt(k, o.matrix); });
  const hg = new THREE.CircleGeometry(1, 14).rotateX(-Math.PI / 2);
  const hm = new THREE.InstancedMesh(hg, tag(new THREE.MeshBasicMaterial({ color: '#160e04' }), CLS.plate), holes.length);
  holes.forEach(([x, y, z, s], k) => { o.position.set(x, y, z); o.scale.setScalar(s); o.updateMatrix(); hm.setMatrixAt(k, o.matrix); });
  const cm = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 40).translate(0, .5, 0), goldMat(new THREE.Color('#d39a39')), cans.length);
  cans.forEach(([x, y, z, rr, hh], k) => { o.position.set(x, y, z); o.scale.set(rr, hh, rr); o.updateMatrix(); cm.setMatrixAt(k, o.matrix); });
  for (const im of [bm, cm]) { im.castShadow = im.receiveShadow = true; scene.add(im); }
  scene.add(hm);
  // Central chambers: the still pot under the still plate, the mixing chamber on the MXC plate, and the cold finger.
  for (const [r, y, h, t] of [[1.2, PLATES[2].c.y - PT / 2 - 2.3, 2.3, '#d9a447'], [.9, MXC_TOP, 2.4, '#e2b259'], [.32, CHIP_POS.y + 1.2, MXC_BOT - CHIP_POS.y - 1.2, '#c98a3e']]) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 48).translate(0, h / 2, 0), goldMat(new THREE.Color(t)));
    m.position.y = y; m.castShadow = m.receiveShadow = true; scene.add(m);
  }

  // Support posts and the thermalising attenuator blocks the coils land on.
  const posts = [], atts = [];
  GAPS.forEach(({ coils, posts: pp }, i) => {
    const y0 = PLATES[i].c.y - PT / 2, y1 = PLATES[i + 1].c.y + PT / 2;
    pp.forEach(p => posts.push([p.x, (y0 + y1) / 2, p.y, y0 - y1]));
    coils.forEach(p => atts.push([p.x, y1, p.y, Math.atan2(p.x - PLATES[i + 1].c.x, p.y - PLATES[i + 1].c.z)]));
  });
  const pm = new THREE.InstancedMesh(new THREE.CylinderGeometry(.16, .16, 1, 14), goldMat(new THREE.Color('#c99234')), posts.length);
  posts.forEach(([x, y, z, h], k) => { o.position.set(x, y, z); o.rotation.set(0, 0, 0); o.scale.set(1, h, 1); o.updateMatrix(); pm.setMatrixAt(k, o.matrix); });
  const am = new THREE.InstancedMesh(new THREE.BoxGeometry(.34, .26, .56).translate(0, .13, 0), goldMat(new THREE.Color('#f0c264')), atts.length);
  atts.forEach(([x, y, z, ry], k) => { o.position.set(x, y, z); o.rotation.set(0, ry, 0); o.scale.setScalar(1); o.updateMatrix(); am.setMatrixAt(k, o.matrix); });
  for (const im of [pm, am]) { im.castShadow = im.receiveShadow = true; scene.add(im); }
}

class Coil extends THREE.Curve {
  constructor(x, z, y0, y1, rad, turns, ph) { super(); Object.assign(this, { x, z, y0, y1, rad, turns, ph }); }
  getPoint(t, o = new THREE.Vector3()) {
    const k = sstep(0, .1, t) * sstep(1, .9, t), a = this.ph + t * this.turns * Math.PI * 2;
    return o.set(this.x + Math.cos(a) * this.rad * k, this.y0 + (this.y1 - this.y0) * t, this.z + Math.sin(a) * this.rad * k);
  }
}
function cableGeo(curve, segs, radius, color, phase) {
  const g = new THREE.TubeGeometry(curve, segs, radius, 6, false), n = g.attributes.position.count, uv = g.attributes.uv;
  const col = new Float32Array(n * 3), al = new Float32Array(n), ph = new Float32Array(n).fill(phase);
  for (let k = 0; k < n; k++) { col[k * 3] = color.r; col[k * 3 + 1] = color.g; col[k * 3 + 2] = color.b; al[k] = uv.getX(k); }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aAlong', new THREE.BufferAttribute(al, 1));
  g.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
  return g;
}
const CABLE_COLS = ['#c98552', '#b0703f', '#aeb4bd', '#d8c7a0', '#d08f5a'].map(c => new THREE.Color(c));
function buildCables(scene) {
  const geos = [];
  GAPS.forEach(({ coils }, i) => {
    const y0 = PLATES[i].c.y - PT / 2, y1 = PLATES[i + 1].c.y + PT / 2 + .26;
    coils.forEach(p => geos.push(cableGeo(new Coil(p.x, p.y, y0, y1, .19 + rnd() * .05, 9 + rnd() * 3, rnd() * 6), 420, .05,
      CABLE_COLS[Math.floor(rnd() * CABLE_COLS.length)], rnd())));
  });
  // Bundles rising from the 50 K plate out of frame, to give the top band texture.
  const top = PLATES[0];
  for (let k = 0; k < 64; k++) {
    const a = rnd() * 6.283, rr = (.35 + .6 * Math.sqrt(rnd())) * (top.r - .7), x = top.c.x + Math.cos(a) * rr, z = top.c.z + Math.sin(a) * rr;
    const y = top.c.y + PT / 2, sway = () => (rnd() - .5) * .6;
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(x + sway() * 2, y + 26, z + sway() * 2), new THREE.Vector3(x + sway(), y + 9, z + sway()), new THREE.Vector3(x, y + 2, z), new THREE.Vector3(x, y, z)]);
    geos.push(cableGeo(curve, 60, .06, CABLE_COLS[Math.floor(rnd() * CABLE_COLS.length)], rnd()));
  }
  const m = new THREE.Mesh(mergeGeometries(geos), tag(new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 60, specular: new THREE.Color('#9a9a9a') }), CLS.cable, pulseExtra));
  m.castShadow = m.receiveShadow = true; scene.add(m);
}

function buildChip(scene) {
  const g = new THREE.Group(), y = -.2, o = new THREE.Object3D();
  const holder = new THREE.Mesh(new THREE.BoxGeometry(4.6, .4, 4.6), tag(new THREE.MeshPhongMaterial({ color: '#c97a45', specular: '#ffcf9a', shininess: 50 }), CLS.plate));
  holder.position.y = y + .2;
  const pcb = new THREE.Mesh(new THREE.BoxGeometry(4.4, .06, 4.4), tag(new THREE.MeshPhongMaterial({ map: pcbTex(), shininess: 20 }), CLS.chip));
  pcb.position.y = y + .43;
  const die = new THREE.Mesh(new THREE.BoxGeometry(CHIP, .06, CHIP), tag(new THREE.MeshPhongMaterial({ map: chipTex(), specular: '#3a3470', shininess: 80 }), CLS.chip));
  die.position.y = y + .49;
  g.add(holder, pcb, die);
  // SMA launchers on the board edge and wire bonds from die to board.
  const sma = new THREE.InstancedMesh(new THREE.CylinderGeometry(.13, .13, .5, 12).rotateZ(Math.PI / 2), goldMat(new THREE.Color('#f2c76a')), 12);
  const bond = new THREE.InstancedMesh(new THREE.BoxGeometry(.025, .02, .22), goldMat(new THREE.Color('#ffe2a0')), 40);
  for (let k = 0; k < 12; k++) {
    const e = k / 3 | 0, p = (k % 3 - 1) * 1.3, ry = e * Math.PI / 2;
    o.position.set(Math.cos(ry) * 2.3 - Math.sin(ry) * p, y + .6, Math.sin(ry) * 2.3 + Math.cos(ry) * p); o.rotation.set(0, -ry, 0); o.updateMatrix(); sma.setMatrixAt(k, o.matrix);
  }
  for (let k = 0; k < 40; k++) {
    const e = k / 10 | 0, p = ((k % 10) / 9 - .5) * (CHIP - .2), ry = e * Math.PI / 2, d = CHIP / 2 + .1;
    o.position.set(Math.cos(ry) * d - Math.sin(ry) * p, y + .5, Math.sin(ry) * d + Math.cos(ry) * p); o.rotation.set(0, Math.PI / 2 - ry, 0); o.updateMatrix(); bond.setMatrixAt(k, o.matrix);
  }
  g.add(sma, bond);
  // Transmons: Xmon crosses with a glowing island, coloured per instance each frame.
  const xmon = mergeGeometries([new THREE.BoxGeometry(.42, .03, .1), new THREE.BoxGeometry(.1, .03, .42), new THREE.CylinderGeometry(.13, .13, .035, 16)]);
  const qubits = new THREE.InstancedMesh(xmon, tag(new THREE.MeshBasicMaterial({ color: '#ffffff' }), CLS.qubit), QN * QN);
  for (let a = 0; a < QN; a++) for (let b = 0; b < QN; b++) {
    o.position.set((a - (QN - 1) / 2) * QPITCH, y + .535, (b - (QN - 1) / 2) * QPITCH); o.rotation.set(0, 0, 0); o.updateMatrix(); qubits.setMatrixAt(a * QN + b, o.matrix);
    qubits.setColorAt(a * QN + b, new THREE.Color(0, 0, 0));
  }
  g.add(qubits);
  g.traverse(m => { if (m.isMesh && m !== qubits) { m.castShadow = m.receiveShadow = true; } });
  g.position.copy(CHIP_POS); g.rotation.x = CHIP_TILT; g.scale.setScalar(CHIP_SCALE);
  scene.add(g);
  const glow = new THREE.PointLight('#b56bff', 7, 9, 1.6); glow.position.set(0, CHIP_POS.y + Math.cos(CHIP_TILT) * 1.6, CHIP_POS.z + Math.sin(CHIP_TILT) * 1.6); scene.add(glow);
  return { qubits, glow };
}

function buildFloor(scene) {
  const f = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), tag(new THREE.MeshLambertMaterial({ map: floorTex() }), CLS.bg));
  f.rotation.x = -Math.PI / 2; f.position.y = FLOOR_Y; f.receiveShadow = true; scene.add(f);
  const pool = canvasTex(256, 256, (x, w) => { const gr = x.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2); gr.addColorStop(0, 'rgba(190,110,255,.55)'); gr.addColorStop(.45, 'rgba(110,50,180,.18)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = gr; x.fillRect(0, 0, w, w); });
  const p = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), tag(new THREE.MeshBasicMaterial({ map: pool, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), CLS.bg));
  p.rotation.x = -Math.PI / 2; p.position.set(0, FLOOR_Y + .02, 0); scene.add(p);
}

// ---------- ascii + tilt shift ----------
const GLYPHS = " .'`,:;-~=+*oOsS$%&8#@/\\|_^v\u2014";
const GI = Object.fromEntries([...GLYPHS].map((c, i) => [c, i]));
const gg = (c) => GI[c].toFixed(1);
function buildAtlas() {
  const tw = 64, th = 120, c = document.createElement('canvas');
  c.width = tw * GLYPHS.length; c.height = th;
  const x = c.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height); x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = 'bold 100px Menlo, Monaco, monospace';
  [...GLYPHS].forEach((ch, i) => { if (ch === '\u2014') x.fillRect(i * tw, th * .44, tw, th * .12); else x.fillText(ch, (i + .5) * tw, th * .52); });
  const t = new THREE.CanvasTexture(c); t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 8; t.flipY = false;
  return t;
}
const asciiFrag = /* glsl */`
precision highp float;
uniform sampler2D uScene, uAtlas; uniform vec2 uGrid; uniform float uTime, uN;
in vec2 vUv; out vec4 outColor;
float h21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float vn(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.-2.*f); return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y); }
float lum(vec3 c){ return dot(c,vec3(.25,.6,.15)); }
vec3 grade(vec3 c){
  c = max(c,0.); c = c/(1.+c*.12); c = pow(c,vec3(1./2.2));
  c = mix(c,c*c*(3.-2.*c),.5);
  float l = lum(c); c = mix(vec3(l),c,1.2);
  return clamp(c,0.,1.);
}
void main(){
  vec2 g = vUv*uGrid, cell = floor(g), cuv = (cell+.5)/uGrid;
  ivec2 sz = textureSize(uScene,0);
  float lodC = log2(float(sz.x)/uGrid.x)+.05;
  vec3 col = grade(textureLod(uScene,cuv,lodC).rgb);
  float cls = floor(texelFetch(uScene,ivec2(cuv*vec2(sz)),0).a*16.+.5);
  float L = lum(col);
  vec2 e = 1./uGrid;
  float lx0=lum(grade(textureLod(uScene,cuv-vec2(e.x,0),lodC).rgb)), lx1=lum(grade(textureLod(uScene,cuv+vec2(e.x,0),lodC).rgb));
  float ly0=lum(grade(textureLod(uScene,cuv-vec2(0,e.y),lodC).rgb)), ly1=lum(grade(textureLod(uScene,cuv+vec2(0,e.y),lodC).rgb));
  vec2 grad = vec2(lx1-lx0,(ly1-ly0)*.55); float mag = length(grad);
  float a4 = mod(atan(grad.y,grad.x)+.3927,3.14159)/.7854;
  float edgeG = a4<1.?${gg('|')}:a4<2.?${gg('\\')}:a4<3.?${gg('\u2014')}:${gg('/')};
  float gl = ${gg(' ')};
  if(cls<0.5){        // nothing rendered
    gl = ${gg(' ')};
  } else if(cls<1.5){ // gold plate: brushed strokes, rims switch to edge strokes
    gl = L<.1?${gg('.')}:L<.2?${gg(':')}:L<.33?${gg('-')}:L<.48?${gg('=')}:L<.66?${gg('#')}:${gg('@')};
    if(mag>.2 && L>.1) gl = edgeG;
  } else if(cls<2.5){ // cable: coils read as strokes along their direction
    gl = L<.1?${gg('.')}:(mag>.07?edgeG:(L<.3?${gg('~')}:L<.55?${gg('s')}:${gg('S')}));
  } else if(cls<3.5){ // chip and board
    gl = L<.07?${gg('.')}:L<.14?${gg(':')}:(mag>.16?edgeG:(L<.26?${gg('+')}:L<.42?${gg('=')}:${gg('#')}));
  } else if(cls<4.5){ // qubit
    gl = L<.25?${gg('o')}:L<.55?${gg('O')}:L<.8?${gg('8')}:${gg('@')};
  } else {            // background floor and drifting motes
    gl = L<.03?${gg(' ')}:L<.06?${gg('.')}:L<.1?${gg(':')}:L<.28?${gg('+')}:${gg('*')};
  }
  vec2 gv = g-cell, dx = dFdx(g), dy = dFdy(g);
  float ink = smoothstep(.12,.78,textureGrad(uAtlas,vec2((gl+gv.x)/uN,1.-gv.y),dx/uN,dy).r);
  vec3 blur = grade(textureLod(uScene,vUv,lodC+1.2).rgb);
  outColor = vec4(mix(blur*.26,col*1.32+.012,ink),1.);
}`;
const tiltFrag = /* glsl */`
precision highp float;
uniform sampler2D uA; uniform vec2 uRes;
in vec2 vUv; out vec4 outColor;
void main(){
  float dy = abs(vUv.y-.34);
  float r = pow(smoothstep(.27,.6,dy),1.6)*28.;
  vec3 c = vec3(0.); float tw = 0.;
  if(r<.2){ outColor = vec4(texture(uA,vUv).rgb,1.); return; }
  float lod = max(log2(r/4.),0.);
  for(int i=0;i<36;i++){
    float t = float(i)+.5, a = t*2.39996, rr = sqrt(t/36.)*r;
    vec2 o = vec2(cos(a),sin(a))*rr/uRes;
    c += textureLod(uA,vUv+o,lod).rgb; tw += 1.;
  }
  outColor = vec4(c/tw,1.);
}`;

const CELL_W = W / COLS, CELL_H = HH / ROWS; // glyph cell size at the original 1440 square
const BASE_TAN = Math.tan(THREE.MathUtils.degToRad(7.5)); // half of the original 15 degree field of view

/**
 * Draw the diorama into `container`, filling it edge to edge.
 * options.focusX: where the cryostat's axis sits across the width (0..1, default 0.5).
 * options.frozenAt: render a single still moment at this time in seconds (reduced motion).
 * options.startAt: start the animation at this time in seconds, so it continues from a poster frame.
 * Returns { dispose }. Throws when WebGL2 is unavailable.
 */
export function mount(container, options = {}) {
  const focusX = options.focusX ?? .5;
  const frozenAt = options.frozenAt ?? null;
  const startAt = options.startAt ?? 0;
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  if (!renderer.capabilities.isWebGL2) { renderer.dispose(); throw new Error('WebGL2 unavailable'); }
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft was removed in three r18x; PCF is what it fell back to
  const canvas = renderer.domElement;
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block' });
  canvas.setAttribute('aria-hidden', 'true');
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight('#fff0d4', 3.4); sun.position.set(24, 44, 30); sun.target.position.set(0, 6, 0);
  sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 32, bottom: -32, near: 5, far: 140 });
  sun.shadow.bias = -.0005; sun.shadow.normalBias = .03;
  scene.add(sun, sun.target, new THREE.HemisphereLight('#dccbf2', '#3a3020', .9));

  buildPlates(scene); buildCables(scene); buildFloor(scene);
  const { qubits, glow } = buildChip(scene);

  // Frost motes drifting down past the stages.
  const NM = 160;
  const motes = new THREE.InstancedMesh(new THREE.PlaneGeometry(.11, .11), tag(new THREE.MeshBasicMaterial({ color: new THREE.Color(.85, .65, 1.1), side: THREE.DoubleSide }), CLS.bg), NM);
  motes.frustumCulled = false; scene.add(motes);
  const moteS = Array.from({ length: NM }, () => [rnd(), rnd(), rnd(), rnd()]);

  const camera = new THREE.PerspectiveCamera(15, 1, 5, 400);
  const TARGET = new THREE.Vector3(0, 3.6, -1.6);
  function placeCamera(t) {
    // Eased sweep across one period, back again on the next, so a live loop never jumps.
    const k = .5 - .5 * Math.cos(Math.PI * t / DURATION), az = THREE.MathUtils.degToRad(-7 + 14 * k), el = THREE.MathUtils.degToRad(32 + 1.4 * Math.sin(k * 3.14)), R = 76 - 2.5 * k;
    camera.position.set(TARGET.x + Math.sin(az) * Math.cos(el) * R, TARGET.y + Math.sin(el) * R, TARGET.z + Math.cos(az) * Math.cos(el) * R);
    camera.lookAt(TARGET); camera.updateMatrixWorld();
  }

  const rtOpts = { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter };
  const rt = new THREE.WebGLRenderTarget(1, 1, rtOpts);
  const vtx = `in vec3 position; in vec2 uv; out vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy,0.,1.); }`;
  const grid = new THREE.Vector2(COLS, ROWS);
  const atlas = buildAtlas();
  const ascii = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: vtx, fragmentShader: asciiFrag, depthTest: false, depthWrite: false,
    uniforms: { uScene: { value: rt.texture }, uAtlas: { value: atlas }, uGrid: { value: grid }, uTime: time, uN: { value: GLYPHS.length } } });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), ascii); quad.frustumCulled = false;
  const post = new THREE.Scene(); post.add(quad); const postCam = new THREE.Camera();

  // Fit the render to the container. The original framing is a 1440 square; a wide box keeps its
  // vertical field and shows more width, a tall box keeps most of its horizontal field. focusX moves
  // the cryostat's axis across the width with a view offset, so nothing is stretched.
  function fit() {
    const w = Math.max(1, Math.round(container.clientWidth)), h = Math.max(1, Math.round(container.clientHeight));
    const aspect = w / h;
    renderer.setSize(w, h, false); rt.setSize(w, h);
    const tanV = aspect >= 1 ? BASE_TAN : (BASE_TAN * .78) / aspect;
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(tanV)); camera.aspect = aspect;
    const full = w * Math.max(1, 2 * Math.max(focusX, 1 - focusX));
    camera.setViewOffset(full, h, focusX >= .5 ? 0 : full - w, 0, w, h);
    camera.updateProjectionMatrix();
    const scale = w < 700 ? .72 : 1; // finer glyphs on small screens
    grid.set(Math.max(24, Math.round(w / (CELL_W * scale))), Math.max(12, Math.round(h / (CELL_H * scale))));
  }

  const dummy = new THREE.Object3D(), qc = new THREE.Color(), CYAN = new THREE.Color(1.05, .45, 1.25);
  function drawFrame(t) {
    time.value = t; placeCamera(t);
    // A slow excitation wave rolls diagonally across the lattice; one qubit at a time flashes as it is read out.
    const readout = Math.floor(t / 1.5) % (QN * QN), rp = fract(t / 1.5);
    for (let a = 0; a < QN; a++) for (let b = 0; b < QN; b++) {
      const i = a * QN + b, wave = Math.pow(.5 + .5 * Math.sin(t * 1.1 - (a + b) * .85), 3);
      const flash = i === (readout * 7) % (QN * QN) ? Math.sin(Math.PI * rp) ** 2 * 1.6 : 0;
      qubits.setColorAt(i, qc.copy(CYAN).multiplyScalar(1.0 + 1.4 * wave + flash));
    }
    qubits.instanceColor.needsUpdate = true;
    glow.intensity = 6 + 2 * Math.sin(t * 1.1);
    moteS.forEach((s, i) => {
      const k = fract(s[0] + t * (.012 + s[3] * .01)), y = 30 - k * 38;
      const x = -11 + s[1] * 22 + Math.sin(t * .5 + s[2] * 9) * .6, z = -9 + s[2] * 18;
      dummy.position.set(x, y, z); dummy.rotation.set(t * .6 + s[0] * 9, t * .4, s[1]); dummy.scale.setScalar(.6 + s[3]);
      dummy.updateMatrix(); motes.setMatrixAt(i, dummy.matrix);
    });
    motes.instanceMatrix.needsUpdate = true;
    renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, camera);
    renderer.setRenderTarget(null); renderer.render(post, postCam); // the glyph pass goes straight to screen
  }

  let raf = 0, visible = true, clock = frozenAt ?? startAt, last = performance.now(), disposed = false, first = true;
  const running = () => frozenAt === null && visible && !document.hidden;
  const loop = (now) => {
    raf = 0;
    if (disposed) return;
    clock += Math.min(.1, (now - last) / 1000); last = now;
    drawFrame(clock); announce();
    if (running()) raf = requestAnimationFrame(loop);
  };
  function announce() { if (first) { first = false; container.dispatchEvent(new CustomEvent('scene-ready')); } }
  function wake() { if (!raf && running()) { last = performance.now(); raf = requestAnimationFrame(loop); } }
  function still() { drawFrame(clock); announce(); }

  fit();
  const ro = new ResizeObserver(() => { fit(); if (!running()) still(); });
  ro.observe(container);
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; wake(); }, { rootMargin: '64px' });
  io.observe(container);
  const onVis = () => wake();
  document.addEventListener('visibilitychange', onVis);
  if (frozenAt !== null) still(); else wake();

  return {
    dispose() {
      disposed = true; if (raf) cancelAnimationFrame(raf);
      ro.disconnect(); io.disconnect(); document.removeEventListener('visibilitychange', onVis);
      scene.traverse((o) => { o.geometry?.dispose?.(); const m = o.material; (Array.isArray(m) ? m : m ? [m] : []).forEach((x) => { Object.values(x).forEach((v) => v?.isTexture && v.dispose()); x.dispose(); }); });
      atlas.dispose(); rt.dispose(); ascii.dispose(); quad.geometry.dispose(); renderer.dispose(); canvas.remove();
    },
  };
}
