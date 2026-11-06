// QPU catalog diorama: the 12 devices of the shared catalog snapshot laid out on a lab floor,
// drawn as coloured glyphs. Superconducting devices are gold dilution-fridge chandeliers;
// trapped-ion devices are vacuum chambers holding an ion chain. Each carries its real name.
//
// mount(container, { select, focus, frozenAt }) draws the scene into `container` and returns
// (focus: a device id; only that device is drawn, centred and lit, as a slowly orbiting portrait)
//
// { setSelected, dispose }. setSelected(deviceId) makes that device glow and dims the others; null
// clears it. A device id is the snapshot's resource_id (devices.json), and candidateToDevice() maps an
// API candidate_id ("braket.Forte_1") to it. frozenAt holds the camera at one moment (reduced motion);
// the selection still changes, instantly. The scene pauses off screen and in hidden tabs.
// standalone.js is the full-window preview (?select=<id>, ?t=<seconds>, Space pauses).
//
// The scene is deliberately static apart from the camera and drifting frost: no signals,
// pulses or flashes, so nothing suggests a job is running.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import CATALOG from './devices.json';

const DEVICES = CATALOG.devices;
const W = 1440, HH = 1440, DURATION = 30; // canvas size; DURATION is one camera sweep in seconds
const COLS = 200, ROWS = 100; // the glyph grid at the original 1440 square: 7.2 by 14.4px cells
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
const M = (x, y, z, rx = 0, ry = 0, rz = 0, s = 1) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(s, s, s));

// ---------- device ids ----------
export const devices = DEVICES.map(({ id, name, vendor, provider, qubits }) => ({ id, name, vendor, provider, qubits }));
/** API candidate_id ("ibm.ibm_fez", "braket.Forte_1") → scene device id, or null. */
export function candidateToDevice(candidateId) {
  const d = DEVICES.find((x) => `${x.provider}.${x.id.replace(/ /g, '_')}` === candidateId);
  return d ? d.id : null;
}

// ---------- materials ----------
// Every lit material is tagged with its glyph class (written to alpha) and multiplied by its device's lit level.
const ONE = { value: 1 };
function tag(mat, cls, lit = ONE) {
  mat.onBeforeCompile = (s) => {
    s.uniforms.uLit = lit;
    s.fragmentShader = 'uniform float uLit;\n' + s.fragmentShader.replace('#include <dithering_fragment>',
      `#include <dithering_fragment>\n gl_FragColor.rgb *= uLit; gl_FragColor.a = ${(cls / 16).toFixed(4)};`);
  };
  mat.customProgramCacheKey = () => `c${cls}`;
  return mat;
}
function canvasTex(w, h, draw, rx = 1, ry = 1) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx, ry); t.anisotropy = 8;
  return t;
}
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
const QN = 4, QPITCH = .62, CHIP = 3.0;
const chipTex = () => canvasTex(512, 512, (x, w) => {
  x.fillStyle = '#16124a'; x.fillRect(0, 0, w, w);
  const s = w / CHIP, q = (k) => w / 2 + (k - (QN - 1) / 2) * QPITCH * s;
  x.lineCap = 'round'; x.strokeStyle = '#5a52b4'; x.lineWidth = 7; x.strokeRect(35, 35, w - 70, w - 70);
  x.strokeStyle = '#6a62c6'; x.lineWidth = 4;
  for (let a = 0; a < QN; a++) for (let b = 0; b < QN; b++) {
    if (a < QN - 1) { x.beginPath(); x.moveTo(q(a) + 20, q(b)); x.lineTo(q(a + 1) - 20, q(b)); x.stroke(); }
    if (b < QN - 1) { x.beginPath(); x.moveTo(q(a), q(b) + 20); x.lineTo(q(a), q(b + 1) - 20); x.stroke(); }
  }
});
const pcbTex = () => canvasTex(256, 256, (x, w) => {
  x.fillStyle = '#1c4743'; x.fillRect(0, 0, w, w);
  x.strokeStyle = '#d4a347'; x.lineWidth = 3;
  for (let k = 0; k < 12; k++) {
    const p = w * (.2 + .6 * (k % 3) / 2), e = k / 3 | 0, inner = w * .5 + (p - w * .5) * .45;
    const pts = [[[p, 3], [inner, w * .33]], [[p, w - 3], [inner, w * .67]], [[3, p], [w * .33, inner]], [[w - 3, p], [w * .67, inner]]][e];
    x.beginPath(); x.moveTo(...pts[0]); x.lineTo(...pts[1]); x.stroke();
  }
});
const floorTex = () => canvasTex(128, 128, (x, w) => {
  x.fillStyle = '#160f26'; x.fillRect(0, 0, w, w);
  x.fillStyle = '#33264f'; x.fillRect(0, 0, w, 3); x.fillRect(0, 0, 3, w);
  x.fillStyle = '#4f3b72'; x.fillRect(0, 0, 9, 3); x.fillRect(0, 0, 3, 9);
}, 300, 300);
const poolTex = () => canvasTex(256, 256, (x, w) => {
  const gr = x.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
  gr.addColorStop(0, 'rgba(190,110,255,.6)'); gr.addColorStop(.45, 'rgba(110,50,180,.2)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = gr; x.fillRect(0, 0, w, w);
});

// ---------- shared geometry helpers ----------
function colorize(g, c) {
  const col = new THREE.Color(c), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) { a[k * 3] = col.r; a[k * 3 + 1] = col.g; a[k * 3 + 2] = col.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
class Coil extends THREE.Curve {
  constructor(x, z, y0, y1, rad, turns, ph) { super(); Object.assign(this, { x, z, y0, y1, rad, turns, ph }); }
  getPoint(t, o = new THREE.Vector3()) {
    const k = sstep(0, .1, t) * sstep(1, .9, t), a = this.ph + t * this.turns * Math.PI * 2;
    return o.set(this.x + Math.cos(a) * this.rad * k, this.y0 + (this.y1 - this.y0) * t, this.z + Math.sin(a) * this.rad * k);
  }
}
const CABLE_COLS = ['#c98552', '#b0703f', '#aeb4bd', '#d8c7a0', '#d08f5a'];
const cable = (curve, segs, radius) => colorize(new THREE.TubeGeometry(curve, segs, radius, 5, false), CABLE_COLS[Math.floor(rnd() * CABLE_COLS.length)]);

// ---------- superconducting device: a gold dilution-fridge chandelier (built once, shared) ----------
const PT = .85, GAP = 3.6;
const PLATES = [7.6, 6.3, 5.1, 4.0, 3.0].map((r, i) => ({ r, y: 4.4 + (4 - i) * GAP }));
const MXC_TOP = PLATES[4].y + PT / 2, MXC_BOT = PLATES[4].y - PT / 2;
const CHIP_M = M(0, 0, .6, THREE.MathUtils.degToRad(58), 0, 0, .6);
const CM = (m) => CHIP_M.clone().multiply(m);

function chandelier() {
  const gold = [], cab = [];
  const G = (geo, c, m) => { gold.push(colorize(m ? geo.applyMatrix4(m) : geo, c)); };
  const gaps = PLATES.slice(0, -1).map((_, i) => {
    const b = PLATES[i + 1], posts = [], coils = [];
    for (let k = 0; k < 4; k++) { const a = (k + .5) / 4 * Math.PI * 2; posts.push(V2(Math.cos(a) * (b.r - .3), Math.sin(a) * (b.r - .3))); }
    const rr = b.r - .55, n = Math.floor(2 * Math.PI * rr / 1.4);
    for (let k = 0; k < n; k++) { const a = k / n * Math.PI * 2, p = V2(Math.cos(a) * rr, Math.sin(a) * rr); if (posts.every(q => q.distanceTo(p) > .6)) coils.push(p); }
    return { posts, coils };
  });
  PLATES.forEach(({ r, y }, i) => {
    const tint = new THREE.Color('#d6ab4c').offsetHSL(-.008 * i, 0, .015 * i);
    G(new THREE.CylinderGeometry(r, r, PT, 96), tint, M(0, y, 0));
    G(new THREE.TorusGeometry(r - .12, .07, 6, 96), tint.clone().multiplyScalar(.8), M(0, y + PT / 2, 0, -Math.PI / 2));
    const n = Math.round(2 * Math.PI * (r - .38) / .6);
    for (let k = 0; k < n; k++) { const a = k / n * Math.PI * 2; G(new THREE.CylinderGeometry(.1, .1, .1, 6), '#f4cf7a', M(Math.cos(a) * (r - .38), y + PT / 2 + .05, Math.sin(a) * (r - .38))); }
    const avoid = [...(gaps[i]?.coils ?? []), ...(gaps[i - 1]?.coils ?? [])];
    const clear = (x, z, d) => avoid.every(p => (p.x - x) ** 2 + (p.y - z) ** 2 > d * d) && Math.hypot(x, z) > 1.5;
    for (let k = 0; k < 28; k++) {
      const a = rnd() * 6.283, rr = (.25 + .65 * Math.sqrt(rnd())) * (r - .8), x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      if (clear(x, z, .7)) G(new THREE.CircleGeometry(rnd() < .3 ? .28 + rnd() * .2 : .08 + rnd() * .1, 12), '#160e04', M(x, y + PT / 2 + .005, z, -Math.PI / 2));
    }
    for (let k = 0, tries = 0; k < 3 && tries < 60; tries++) {
      const a = rnd() * 6.283, rr = rnd() * (r - 1.6), x = Math.cos(a) * rr, z = Math.sin(a) * rr, cr = .45 + rnd() * .5, ch = .5 + rnd() * .9;
      if (!clear(x, z, 1.2)) continue;
      G(new THREE.CylinderGeometry(cr, cr, ch, 24), '#d39a39', M(x, y + PT / 2 + ch / 2, z)); k++;
    }
  });
  gaps.forEach(({ posts, coils }, i) => {
    const y0 = PLATES[i].y - PT / 2, y1 = PLATES[i + 1].y + PT / 2;
    posts.forEach(p => G(new THREE.CylinderGeometry(.16, .16, y0 - y1, 10), '#c99234', M(p.x, (y0 + y1) / 2, p.y)));
    coils.forEach(p => {
      G(new THREE.BoxGeometry(.34, .26, .56), '#f0c264', M(p.x, y1 + .13, p.y, 0, Math.atan2(p.x, p.y)));
      cab.push(cable(new Coil(p.x, p.y, y0, y1 + .26, .19 + rnd() * .05, 5 + rnd() * 2, rnd() * 6), 130, .06));
    });
  });
  // Still pot, mixing-chamber can, cold finger, and the mount above the top plate.
  const top = PLATES[0].y + PT / 2;
  G(new THREE.CylinderGeometry(1.2, 1.2, 2, 40), '#d9a447', M(0, PLATES[2].y - PT / 2 - 1, 0));
  G(new THREE.CylinderGeometry(.9, .9, 1.8, 40), '#e2b259', M(0, MXC_TOP + .9, 0));
  G(new THREE.CylinderGeometry(.32, .32, MXC_BOT - 1.2, 16), '#c98a3e', M(0, (MXC_BOT + 1.2) / 2, 0));
  G(new THREE.CylinderGeometry(1, 1, 2.2, 32), '#c99234', M(0, top + 1.1, 0));
  G(new THREE.CylinderGeometry(2.4, 2.4, .3, 48), '#d6ab4c', M(0, top + 2.35, 0));
  for (let k = 0; k < 12; k++) { const a = k / 12 * Math.PI * 2 + .2, rr = 3.4 + rnd() * 1.6; cab.push(cable(new Coil(Math.cos(a) * rr, Math.sin(a) * rr, top + 2.8, top, 0, 0, 0), 8, .06)); }
  // Sample holder hanging under the MXC plate, die facing the camera.
  G(new THREE.BoxGeometry(4.6, .4, 4.6), '#c97a45', CM(M(0, 0, 0)));
  for (let k = 0; k < 12; k++) {
    const e = k / 3 | 0, p = (k % 3 - 1) * 1.3, ry = e * Math.PI / 2;
    G(new THREE.CylinderGeometry(.13, .13, .5, 10).rotateZ(Math.PI / 2), '#f2c76a', CM(M(Math.cos(ry) * 2.3 - Math.sin(ry) * p, .4, Math.sin(ry) * 2.3 + Math.cos(ry) * p, 0, -ry)));
  }
  const qubits = [];
  for (let a = 0; a < QN; a++) for (let b = 0; b < QN; b++) {
    const m = CM(M((a - (QN - 1) / 2) * QPITCH, .335, (b - (QN - 1) / 2) * QPITCH));
    for (const g of [new THREE.BoxGeometry(.42, .03, .1), new THREE.BoxGeometry(.1, .03, .42), new THREE.CylinderGeometry(.13, .13, .035, 12)]) qubits.push(g.applyMatrix4(m));
  }
  return {
    gold: mergeGeometries(gold), cables: mergeGeometries(cab),
    pcb: new THREE.BoxGeometry(4.4, .06, 4.4).applyMatrix4(CM(M(0, .23, 0))),
    die: new THREE.BoxGeometry(CHIP, .06, CHIP).applyMatrix4(CM(M(0, .29, 0))),
    qubits: mergeGeometries(qubits),
    glow: new THREE.Vector3(0, .3, 0).applyMatrix4(CM(M(0, 2, 0))), labelZ: PLATES[0].r + .6, scale: .55,
  };
}

// ---------- trapped-ion device: a vacuum chamber with a linear ion chain ----------
function ionTrap(nIons) {
  const steel = [], cab = [], ions = [];
  const G = (geo, c, m) => { steel.push(colorize(m ? geo.applyMatrix4(m) : geo, c)); };
  G(new THREE.CylinderGeometry(1.3, 1.7, 4, 32), '#7d8590', M(0, 2, 0));
  G(new THREE.CylinderGeometry(4, 4, .5, 64), '#aab3be', M(0, 4.25, 0));
  for (let k = 0; k < 24; k++) { const a = k / 24 * Math.PI * 2; G(new THREE.CylinderGeometry(.12, .12, .12, 6), '#d0d6dd', M(Math.cos(a) * 3.65, 4.56, Math.sin(a) * 3.65)); }
  for (let k = 0; k < 8; k++) { const a = (k + .5) / 8 * Math.PI * 2; G(new THREE.CylinderGeometry(.16, .16, 5, 8), '#9aa3ad', M(Math.cos(a) * 3.4, 7, Math.sin(a) * 3.4)); }
  G(new THREE.TorusGeometry(3.4, .32, 10, 64), '#b8c0ca', M(0, 9.6, 0, -Math.PI / 2));
  G(new THREE.TorusGeometry(3.4, .16, 8, 64), '#d6ab4c', M(0, 9.9, 0, -Math.PI / 2));
  G(new THREE.BoxGeometry(1.8, 1.6, 1.8), '#c9a24a', M(0, 5.3, 0));
  for (const z of [-.42, .42]) G(new THREE.BoxGeometry(6.2, .22, .35), '#e0b555', M(0, 6.4, z));
  for (const z of [-.75, .75]) G(new THREE.CylinderGeometry(.09, .09, 6.2, 8), '#e8c46e', M(0, 6.05, z, 0, 0, Math.PI / 2));
  for (let k = 0; k < 8; k++) {
    const a = k / 8 * Math.PI * 2 + .3, c = Math.cos(a), s = Math.sin(a);
    cab.push(cable(new THREE.CatmullRomCurve3([new THREE.Vector3(c * 1.6, 3.9, s * 1.6), new THREE.Vector3(c * 2.4, 2, s * 2.4), new THREE.Vector3(c * 3.6, .15, s * 3.6)]), 24, .08));
  }
  const span = 5.2;
  for (let k = 0; k < nIons; k++) ions.push(new THREE.SphereGeometry(.2, 10, 8).applyMatrix4(M(-span / 2 + span * k / Math.max(1, nIons - 1), 6.75, 0)));
  return { gold: mergeGeometries(steel), cables: mergeGeometries(cab), qubits: mergeGeometries(ions), glow: new THREE.Vector3(0, 7.6, 1.2), labelZ: 4.6, scale: .62 };
}

// ---------- layout: three rows, tall fridges at the back, compact ion chambers in front ----------
const isIon = d => /ionq|aqt/i.test(d.vendor);
function layout() {
  const front = DEVICES.filter(isIon), rest = DEVICES.filter(d => !isIon(d)).sort((a, b) => a.qubits - b.qubits);
  const rows = [rest.slice(6), rest.slice(3, 6), rest.slice(0, 3), front]; // back to front
  const SX = 13, SZ = 12, out = [];
  rows.forEach((row, ri) => row.forEach((d, ci) => {
    const x = (ci - (row.length - 1) / 2) * SX + [-SX / 4, SX / 4, -SX / 4, 0][ri], z = (ri - 1.5) * SZ;
    out.push({ d, x, z });
  }));
  return out;
}

function buildFloor(scene) {
  const f = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), tag(new THREE.MeshLambertMaterial({ map: floorTex() }), CLS.bg));
  f.rotation.x = -Math.PI / 2; f.receiveShadow = true; scene.add(f);
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(13, 13), tag(new THREE.MeshBasicMaterial({ map: poolTex(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0x000000 }), CLS.bg));
  pool.rotation.x = -Math.PI / 2; pool.position.y = .03; scene.add(pool);
  return pool;
}

// ---------- ascii ----------
const BASE = " .'`,:;-~=+*oOsS$%&8#@/\\|_^v\u2014[]";
const GLYPHS = [...new Set([...BASE, ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'])].join('');
const GI = Object.fromEntries([...GLYPHS].map((c, i) => [c, i]));
const gg = (c) => GI[c].toFixed(1);
function buildAtlas() {
  const tw = 64, th = 120, c = document.createElement('canvas');
  c.width = tw * GLYPHS.length; c.height = th;
  const x = c.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height); x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = 'bold 100px Menlo, Monaco, monospace';
  [...GLYPHS].forEach((ch, i) => { if (ch === '\u2014') x.fillRect(i * tw, th * .44, tw, th * .12); else x.fillText(ch, (i + .5) * tw, th * .52, tw); });
  const t = new THREE.CanvasTexture(c); t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 8; t.flipY = false;
  return t;
}
const asciiFrag = /* glsl */`
precision highp float;
uniform sampler2D uScene, uAtlas, uLabel; uniform vec2 uGrid; uniform float uN;
in vec2 vUv; out vec4 outColor;
float lum(vec3 c){ return dot(c,vec3(.25,.6,.15)); }
vec3 grade(vec3 c){
  c = max(c,0.); c = c/(1.+c*.12); c = pow(c,vec3(1./2.2));
  c = mix(c,c*c*(3.-2.*c),.5);
  float l = lum(c); c = mix(vec3(l),c,1.2);
  return clamp(c,0.,1.);
}
void main(){
  vec2 g = vUv*uGrid, cell = floor(g), cuv = (cell+.5)/uGrid, gv = g-cell, dx = dFdx(g), dy = dFdy(g);
  // Device names are real text cells, written per frame into uLabel (glyph index + 1, state).
  vec4 lab = texelFetch(uLabel, ivec2(cell), 0);
  float lg = floor(lab.r*255.+.5)-1.;
  float labInk = smoothstep(.12,.78,textureGrad(uAtlas,vec2((max(lg,0.)+gv.x)/uN,1.-gv.y),dx/uN,dy).r);
  if(lab.r > 0.){
    vec3 lc = lab.g>.9 ? vec3(1.,.88,1.05) : lab.g>.4 ? vec3(.9,.78,.55) : vec3(.4,.34,.48);
    outColor = vec4(mix(vec3(.03,.015,.05), lc, labInk), 1.);
    return;
  }
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
  if(cls<0.5){
    gl = ${gg(' ')};
  } else if(cls<1.5){ // gold plate / chamber metal
    gl = L<.1?${gg('.')}:L<.2?${gg(':')}:L<.33?${gg('-')}:L<.48?${gg('=')}:L<.66?${gg('#')}:${gg('@')};
    if(mag>.2 && L>.1) gl = edgeG;
  } else if(cls<2.5){ // cable
    gl = L<.1?${gg('.')}:(mag>.07?edgeG:(L<.3?${gg('~')}:L<.55?${gg('s')}:${gg('S')}));
  } else if(cls<3.5){ // chip and board
    gl = L<.07?${gg('.')}:L<.14?${gg(':')}:(mag>.16?edgeG:(L<.26?${gg('+')}:L<.42?${gg('=')}:${gg('#')}));
  } else if(cls<4.5){ // qubit
    gl = L<.25?${gg('o')}:L<.55?${gg('O')}:L<.8?${gg('8')}:${gg('@')};
  } else {            // background
    gl = L<.03?${gg(' ')}:L<.06?${gg('.')}:L<.1?${gg(':')}:L<.28?${gg('+')}:${gg('*')};
  }
  float ink = smoothstep(.12,.78,textureGrad(uAtlas,vec2((gl+gv.x)/uN,1.-gv.y),dx/uN,dy).r);
  vec3 blur = grade(textureLod(uScene,vUv,lodC+1.2).rgb);
  outColor = vec4(mix(blur*.26,col*1.32+.012,ink),1.);
}`;

export function mount(container, options = {}) {
  // focus: draw only this device, centred, lit, and framed as a portrait (the catalog detail page).
  const focus = options.focus != null ? DEVICES.find((d) => d.id === options.focus) ?? null : null;
  if (options.focus != null && !focus) throw new Error(`qpu-catalog: unknown device "${options.focus}"`);
  let selectedId = focus ? focus.id : options.select ?? null;
  const frozenAt = options.frozenAt ?? null;
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  if (!renderer.capabilities.isWebGL2) { renderer.dispose(); throw new Error('WebGL2 unavailable'); }
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  const canvas = renderer.domElement;
  Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%' });
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight('#fff0d4', 3.2); sun.position.set(40, 60, 46); sun.target.position.set(0, 3, 0);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 5, far: 180 });
  sun.shadow.bias = -.0005; sun.shadow.normalBias = .03;
  scene.add(sun, sun.target, new THREE.HemisphereLight('#dccbf2', '#3a3020', .9));

  const goldMap = goldTex(), dieMap = chipTex(), pcbMap = pcbTex();
  const SC = chandelier();
  const devs = (focus ? [{ d: focus, x: 0, z: 0 }] : layout()).map(({ d, x, z }) => {
    const T = isIon(d) ? ionTrap(Math.min(d.qubits, 16)) : SC;
    const lit = { value: 1 }, g = new THREE.Group();
    const add = (geo, mat, shadow = true) => { const m = new THREE.Mesh(geo, mat); m.castShadow = m.receiveShadow = shadow; g.add(m); return m; };
    add(T.gold, tag(new THREE.MeshPhongMaterial({ vertexColors: true, map: goldMap, specular: new THREE.Color('#ffdf9a'), shininess: 38 }), CLS.plate, lit));
    add(T.cables, tag(new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 60, specular: new THREE.Color('#9a9a9a') }), CLS.cable, lit));
    if (T.pcb) {
      add(T.pcb, tag(new THREE.MeshPhongMaterial({ map: pcbMap, shininess: 20 }), CLS.chip, lit));
      add(T.die, tag(new THREE.MeshPhongMaterial({ map: dieMap, specular: '#3a3470', shininess: 80 }), CLS.chip, lit));
    }
    const qmat = tag(new THREE.MeshBasicMaterial({ color: 0x000000 }), CLS.qubit);
    add(T.qubits, qmat, false);
    g.position.set(x, 0, z); g.rotation.y = (rnd() - .5) * .4; g.scale.setScalar(T.scale);
    scene.add(g); g.updateMatrixWorld();
    return { ...d, group: g, lit, q: .55, qmat, glow: T.glow.clone().applyMatrix4(g.matrixWorld), anchor: new THREE.Vector3(x, .05, z + 1.6) };
  });
  const pool = buildFloor(scene);
  const glowLight = new THREE.PointLight('#b56bff', 0, 10, 1.6); scene.add(glowLight);
  let glowAmt = 0, glowDev = null;

  // Frost drifting down through the room: ambient only.
  const NM = 220;
  const motes = new THREE.InstancedMesh(new THREE.PlaneGeometry(.14, .14), tag(new THREE.MeshBasicMaterial({ color: new THREE.Color(.85, .65, 1.1), side: THREE.DoubleSide }), CLS.bg), NM);
  motes.frustumCulled = false; scene.add(motes);
  const moteS = Array.from({ length: NM }, () => [rnd(), rnd(), rnd(), rnd()]);

  const camera = new THREE.PerspectiveCamera(23, 1, focus ? 1 : 5, 600);
  const TARGET = new THREE.Vector3(0, 4, 0);
  // In focus mode the camera frames the one device from its bounding box: far enough that its
  // height fills about 80% of the view, aimed at its middle, a little above eye level.
  let FOCUS_R = 0;
  if (focus) {
    const box = new THREE.Box3().setFromObject(devs[0].group), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    TARGET.copy(c);
    FOCUS_R = (Math.max(size.y, size.x * 1.1) / .8 / 2) / Math.tan(THREE.MathUtils.degToRad(23 / 2));
  }
  function placeCamera(t) {
    if (focus) {
      // A slow half orbit around the device, swinging back and forth.
      const k = .5 - .5 * Math.cos(Math.PI * t / (DURATION * 1.5)), az = THREE.MathUtils.degToRad(-28 + 56 * k), el = THREE.MathUtils.degToRad(14 + 4 * Math.sin(k * 3.14));
      camera.position.set(TARGET.x + Math.sin(az) * Math.cos(el) * FOCUS_R, TARGET.y + Math.sin(el) * FOCUS_R, TARGET.z + Math.cos(az) * Math.cos(el) * FOCUS_R);
      camera.lookAt(TARGET); camera.updateMatrixWorld();
      return;
    }
    const k = .5 - .5 * Math.cos(Math.PI * t / DURATION), az = THREE.MathUtils.degToRad(-6 + 12 * k), el = THREE.MathUtils.degToRad(38 + 1.2 * Math.sin(k * 3.14)), R = 108 - 3 * k;
    camera.position.set(TARGET.x + Math.sin(az) * Math.cos(el) * R, TARGET.y + Math.sin(el) * R, TARGET.z + Math.cos(az) * Math.cos(el) * R);
    camera.lookAt(TARGET); camera.updateMatrixWorld();
  }

  // The grid follows the render size so a glyph keeps its original cell (and labels stay legible).
  let cols = COLS, rows = ROWS;
  let labData = new Uint8Array(cols * rows * 4);
  let labTex = new THREE.DataTexture(labData, cols, rows, THREE.RGBAFormat);
  labTex.magFilter = labTex.minFilter = THREE.NearestFilter;
  const rt = new THREE.WebGLRenderTarget(W, HH, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
  const vtx = `in vec3 position; in vec2 uv; out vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy,0.,1.); }`;
  const ascii = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: vtx, fragmentShader: asciiFrag, depthTest: false, depthWrite: false,
    uniforms: { uScene: { value: rt.texture }, uAtlas: { value: buildAtlas() }, uLabel: { value: labTex }, uGrid: { value: new THREE.Vector2(cols, rows) }, uN: { value: GLYPHS.length } } });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), ascii); quad.frustumCulled = false;
  const post = new THREE.Scene(); post.add(quad); const postCam = new THREE.Camera();

  const dummy = new THREE.Object3D(), v = new THREE.Vector3();
  function writeLabels() {
    labData.fill(0);
    if (focus) { labTex.needsUpdate = true; return; } // the page names the device
    const order = [...devs].sort((a, b) => (a.id === selectedId) - (b.id === selectedId)); // selected drawn last, on top
    for (const dev of order) {
      // On a small grid the names would run together: label only the selected device there.
      if (cols < 70 && selectedId != null && dev.id !== selectedId) continue;
      v.copy(dev.anchor).project(camera);
      const sel = dev.id === selectedId, state = selectedId == null ? 150 : sel ? 255 : 60;
      const text = sel ? `[ ${dev.name} ]` : ` ${dev.name} `;
      const row = Math.floor((v.y * .5 + .5) * rows), c0 = Math.max(0, Math.min(cols - text.length, Math.round((v.x * .5 + .5) * cols - text.length / 2))); // kept inside the grid
      if (row < 0 || row >= rows) continue;
      for (let i = 0; i < text.length; i++) {
        const c = c0 + i; if (c < 0 || c >= cols) continue;
        const o = (row * cols + c) * 4; labData[o] = GI[text[i]] + 1; labData[o + 1] = state; labData[o + 3] = 255;
      }
    }
    labTex.needsUpdate = true;
  }
  function drawFrame(t, dt) {
    placeCamera(t);
    // Selection eases in: chosen device brightens and its qubits glow steadily; the rest dim.
    const k = 1 - Math.exp(-dt * 5);
    for (const dev of devs) {
      const sel = dev.id === selectedId;
      const tl = selectedId == null ? 1 : sel ? 1.15 : .3, tq = selectedId == null ? .6 : sel ? 1.7 : .14;
      dev.lit.value += (tl - dev.lit.value) * k; dev.q += (tq - dev.q) * k;
      dev.qmat.color.setRGB(1.05 * dev.q, .45 * dev.q, 1.25 * dev.q);
    }
    const target = devs.find(d => d.id === selectedId);
    if (target && target !== glowDev) { if (glowAmt < .05) glowDev = target; }
    glowAmt += ((target && target === glowDev ? 1 : 0) - glowAmt) * k;
    if (glowDev) {
      glowLight.position.copy(glowDev.glow); glowLight.intensity = 9 * glowAmt;
      pool.position.set(glowDev.anchor.x, .03, glowDev.anchor.z - 1.2); pool.material.color.setScalar(.7 * glowAmt);
    }
    moteS.forEach((s, i) => {
      const kk = fract(s[0] + t * (.01 + s[3] * .008)), y = 22 - kk * 24;
      const x = -30 + s[1] * 60 + Math.sin(t * .4 + s[2] * 9) * .6, z = -22 + s[2] * 44;
      dummy.position.set(x, y, z); dummy.rotation.set(t * .5 + s[0] * 9, t * .3, s[1]); dummy.scale.setScalar(.6 + s[3]);
      dummy.updateMatrix(); motes.setMatrixAt(i, dummy.matrix);
    });
    motes.instanceMatrix.needsUpdate = true;
    writeLabels();
    renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, camera);
    renderer.setRenderTarget(null); renderer.render(post, postCam);
  }
  // The scene is square: the render follows the container's width (up to the original 1440), and
  // the glyph grid stays 200 by 100, so the picture is the same at every size.
  function fit() {
    const S = Math.max(64, Math.min(W, Math.round(container.clientWidth)));
    renderer.setSize(S, S, false); rt.setSize(S, S);
    const nc = Math.max(40, Math.round(S / (W / COLS))), nr = Math.max(20, Math.round(S / (HH / ROWS)));
    if (nc !== cols || nr !== rows) {
      cols = nc; rows = nr;
      labTex.dispose();
      labData = new Uint8Array(cols * rows * 4);
      labTex = new THREE.DataTexture(labData, cols, rows, THREE.RGBAFormat);
      labTex.magFilter = labTex.minFilter = THREE.NearestFilter;
      ascii.uniforms.uLabel.value = labTex;
      ascii.uniforms.uGrid.value.set(cols, rows);
    }
  }
  fit();
  const ro = new ResizeObserver(() => { fit(); if (!running()) still(); });
  ro.observe(container);

  let raf = 0, visible = true, clock = frozenAt ?? 0, last = performance.now(), snap = true, disposed = false, announced = false;
  const running = () => frozenAt === null && visible && !document.hidden;
  const announce = () => { if (!announced) { announced = true; container.dispatchEvent(new CustomEvent('scene-ready')); } };
  function frame(now) {
    raf = 0;
    if (disposed) return;
    const dt = snap ? 10 : Math.min(.1, (now - last) / 1000); // a snap jumps the selection state
    if (!snap) clock += dt;
    last = now; snap = false;
    drawFrame(clock, dt); announce();
    if (running()) raf = requestAnimationFrame(frame);
  }
  function still() { snap = true; frame(performance.now()); }
  function wake() { if (!raf && running()) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; wake(); });
  io.observe(container);
  const onVis = () => wake();
  document.addEventListener('visibilitychange', onVis);
  if (frozenAt !== null) still(); else { snap = true; wake(); }

  return {
    setSelected(deviceId) {
      if (deviceId != null && !DEVICES.some((d) => d.id === deviceId)) { console.warn(`qpu-catalog: unknown device "${deviceId}"`); return false; }
      selectedId = deviceId ?? null;
      if (!running()) still(); // paused or reduced motion: show the new state at once
      return true;
    },
    dispose() {
      disposed = true; cancelAnimationFrame(raf); io.disconnect(); ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      scene.traverse((o) => { o.geometry?.dispose?.(); [].concat(o.material ?? []).forEach((m) => { m.map?.dispose?.(); m.dispose?.(); }); });
      rt.dispose(); ascii.uniforms.uAtlas.value.dispose(); labTex.dispose(); renderer.dispose(); canvas.remove();
    },
  };
}
