// Background 3D story, told on the right while the content scrolls on the left:
//   hero        the main web: an embedding space of clustered vectors
//   about       ingest: document pages fly in and get split into chunks
//   work        sort and store: chunks drop into a vector database and sort into layers
//   experience  intelligence arrives: the LLM core forms above the database
//   projects    interaction: the core queries the database, retrieved chunks rise into it
//   skills      answer: tokens stream out, an LLM-as-judge ring scores the result
//   beyond      zoom out: the whole stage recedes
//   contact     the main web returns, full screen, in the background
// Loaded as a classic script so the page also works from file://, where Chrome
// blocks local ES modules. Three.js comes from the CDN.
(async () => {
let THREE;
try {
  THREE = await import("https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js");
} catch (err) {
  document.documentElement.classList.add("no-webgl");
  return;
}

const canvas = document.getElementById("bg-canvas");
const hud = document.getElementById("hud-text");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const small = window.innerWidth < 768;

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
} catch (err) {
  document.documentElement.classList.add("no-webgl");
  return;
}
if (document.fonts) await document.fonts.ready;

renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setClearColor(0x000000, 0);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 140);
camera.position.set(0, 0, 19);

const rand = mulberry32(7);
const gauss = () => { let u = 0, v = 0; while (!u) u = rand(); while (!v) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const ease = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };

/* ------------------------------------------------------------------ */
/* Materials                                                           */
/* ------------------------------------------------------------------ */
const shared = { uTime: { value: 0 }, uPixelRatio: { value: renderer.getPixelRatio() }, uLight: { value: 0 } };
const glowMaterials = [];
function glowMaterial(size, twinkle) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...shared, uOpacity: { value: 1 }, uSize: { value: size }, uTwinkle: { value: twinkle ? 1 : 0 } },
    vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute float size; attribute float phase;
      uniform float uTime, uPixelRatio, uTwinkle, uSize, uLight;
      varying vec3 vColor; varying float vTw;
      void main() {
        vColor = color;
        vTw = mix(1.0, 0.65 + 0.35 * sin(uTime * 1.6 + phase), uTwinkle);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = uSize * size * mix(1.0, 0.72, uLight) * uPixelRatio * (12.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float uOpacity, uLight;
      varying vec3 vColor; varying float vTw;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        float core = smoothstep(0.5, 0.0, d);
        float glow = pow(core, 2.2);
        vec3 col = mix(vColor * (0.6 + glow), vColor, uLight);
        float a = mix(glow, smoothstep(0.5, 0.3, d) * 0.9, uLight);
        gl_FragColor = vec4(col, a * vTw * uOpacity);
      }`,
  });
  glowMaterials.push(mat);
  return mat;
}
function pointsGeometry(count, { positions, colors, sizes, phases } = {}) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions || new Float32Array(count * 3), 3));
  g.setAttribute("color", new THREE.BufferAttribute(colors || new Float32Array(count * 3).fill(1), 3));
  g.setAttribute("size", new THREE.BufferAttribute(sizes || new Float32Array(count).fill(1), 1));
  g.setAttribute("phase", new THREE.BufferAttribute(phases || new Float32Array(count), 1));
  return g;
}
const lineMaterials = [];
function lineMaterial(base, vertexColors = false) {
  const m = new THREE.LineBasicMaterial({ vertexColors, transparent: true, opacity: base, blending: THREE.AdditiveBlending, depthWrite: false });
  m.userData.base = base;
  lineMaterials.push(m);
  return m;
}
// Mono text label drawn on a canvas; redrawn when the palette is applied.
const labelSprites = [];
function makeLabel(text, colorIndex, parent, scale = 1) {
  const cv = document.createElement("canvas"); cv.width = 512; cv.height = 96;
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2.8 * scale, 0.525 * scale, 1);
  parent.add(sprite);
  const label = { cv, tex, mat, sprite, text, colorIndex };
  labelSprites.push(label);
  return label;
}

/* ------------------------------------------------------------------ */
/* 1. Main web: embedding space                                        */
/* ------------------------------------------------------------------ */
const web = new THREE.Group();
scene.add(web);
const CLUSTERS = 7, PER = small ? 55 : 95, HAZE = small ? 240 : 560, N = CLUSTERS * PER + HAZE;
const nodePos = new Float32Array(N * 3), nodeCol = new Float32Array(N * 3), nodeSize = new Float32Array(N), nodePhase = new Float32Array(N);
const clusterOf = new Int8Array(N), tint = new Float32Array(N);
const centers = [];
for (let c = 0; c < CLUSTERS; c++) {
  const theta = (c / CLUSTERS) * Math.PI * 2 + rand() * 0.4, phi = Math.acos(2 * rand() - 1);
  centers.push(new THREE.Vector3(Math.sin(phi) * Math.cos(theta), Math.cos(phi) * 0.75, Math.sin(phi) * Math.sin(theta)).multiplyScalar(6.4));
}
let n = 0;
centers.forEach((center, c) => {
  for (let i = 0; i < PER; i++, n++) {
    const s = 0.7 + rand() * 0.25;
    nodePos.set([center.x + gauss() * s, center.y + gauss() * s, center.z + gauss() * s], n * 3);
    nodeSize[n] = 0.55 + rand() * 1.1; nodePhase[n] = rand() * 6.28; clusterOf[n] = c; tint[n] = rand() * 0.25;
  }
});
for (let i = 0; i < HAZE; i++, n++) {
  const r = 6 + rand() * 9, t = rand() * 6.28, p = Math.acos(2 * rand() - 1);
  nodePos.set([r * Math.sin(p) * Math.cos(t), r * Math.cos(p) * 0.7, r * Math.sin(p) * Math.sin(t)], n * 3);
  nodeSize[n] = 0.25 + rand() * 0.45; nodePhase[n] = rand() * 6.28; clusterOf[n] = -1;
}
const nodeGeo = pointsGeometry(N, { positions: nodePos, colors: nodeCol, sizes: nodeSize, phases: nodePhase });
const nodeMat = glowMaterial(12, true);
web.add(new THREE.Points(nodeGeo, nodeMat));

const edges = [], adjacency = Array.from({ length: CLUSTERS * PER }, () => []);
const addEdge = (a, b) => {
  if (adjacency[a].some((e) => edges[e][0] === b || edges[e][1] === b)) return;
  edges.push([a, b]); adjacency[a].push(edges.length - 1); adjacency[b].push(edges.length - 1);
};
for (let c = 0; c < CLUSTERS; c++) {
  const s = c * PER;
  for (let i = s; i < s + PER; i++) {
    const pi = vecAt(nodePos, i), near = [];
    for (let j = s; j < s + PER; j++) if (j !== i) near.push([pi.distanceToSquared(vecAt(nodePos, j)), j]);
    near.sort((a, b) => a[0] - b[0]);
    near.slice(0, 2).forEach(([, j]) => addEdge(i, j));
  }
  addEdge(c * PER + Math.floor(rand() * PER), ((c + 1 + Math.floor(rand() * (CLUSTERS - 1))) % CLUSTERS) * PER + Math.floor(rand() * PER));
}
const edgePos = new Float32Array(edges.length * 6), edgeCol = new Float32Array(edges.length * 6);
edges.forEach(([a, b], k) => edgePos.set([...vecAt(nodePos, a).toArray(), ...vecAt(nodePos, b).toArray()], k * 6));
const edgeGeo = new THREE.BufferGeometry();
edgeGeo.setAttribute("position", new THREE.BufferAttribute(edgePos, 3));
edgeGeo.setAttribute("color", new THREE.BufferAttribute(edgeCol, 3));
const edgeMat = lineMaterial(0.22, true);
web.add(new THREE.LineSegments(edgeGeo, edgeMat));

const PULSES = small ? 40 : 90, pulses = [];
const pulseGeo = pointsGeometry(PULSES, { sizes: new Float32Array(PULSES).fill(1.6) });
for (let i = 0; i < PULSES; i++) { const e = Math.floor(rand() * edges.length); pulses.push({ edge: e, from: edges[e][0], t: rand(), speed: 0.35 + rand() * 0.6 }); }
const pulseMat = glowMaterial(13, false);
web.add(new THREE.Points(pulseGeo, pulseMat));
const WEB_LABELS = ["retrieval", "agents", "evals", "routing", "tools", "guardrails", "embeddings"];
const webLabels = centers.map((center, c) => {
  const l = makeLabel("// " + WEB_LABELS[c], c, web);
  l.sprite.position.copy(center).add(new THREE.Vector3(1.6, 1.5, 0));
  return l;
});

/* ------------------------------------------------------------------ */
/* 2. Story stage (right side): documents, vector DB, LLM core         */
/* ------------------------------------------------------------------ */
const stage = new THREE.Group();
scene.add(stage);
const rig = new THREE.Group();        // tilted so the database rings read as ellipses
rig.rotation.x = 0.3;
stage.add(rig);

/* 2a. Documents that get split into chunk strips */
const DOCS = 4, STRIPS = 6, SW = 1.4, SH = 0.28, GAP = 0.05, DOC_TOP = 4.3;
const stripGeo = new THREE.PlaneGeometry(SW, SH);
const stripMats = [], stripCanvases = [];
for (let s = 0; s < STRIPS; s++) {
  const cv = document.createElement("canvas"); cv.width = 280; cv.height = 56;
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  stripCanvases.push({ cv, tex, seed: s });
  stripMats.push(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
}
const strips = [];
for (let d = 0; d < DOCS; d++) {
  for (let s = 0; s < STRIPS; s++) {
    const mesh = new THREE.Mesh(stripGeo, stripMats[s]);
    rig.add(mesh);
    strips.push({ mesh, d, s, jx: (rand() - 0.5) * 2, jz: (rand() - 0.5) * 2, jr: (rand() - 0.5) * 0.9 });
  }
}
const docsLabel = makeLabel("// documents", 0, rig, 0.9);
docsLabel.sprite.position.set(0, DOC_TOP + 0.75, 0);

/* 2b. Vector database: stacked rings, chunks sorted by colour into layers */
const db = new THREE.Group();
db.position.set(0, -2.3, 0);
rig.add(db);
const LAYERS = 5, PER_LAYER = 54, R = 1.9, LAYER_GAP = 0.62, DB_BOTTOM = -1.25;
const ringMats = [];
for (let i = 0; i <= LAYERS; i++) {
  const y = DB_BOTTOM + i * LAYER_GAP - LAYER_GAP / 2;
  const pts = Array.from({ length: 97 }, (_, k) => { const a = (k / 96) * Math.PI * 2; return new THREE.Vector3(Math.cos(a) * (R + 0.35), y, Math.sin(a) * (R + 0.35)); });
  const mat = lineMaterial(i === 0 || i === LAYERS ? 0.55 : 0.25);
  ringMats.push(mat);
  db.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
}
const sideMat = lineMaterial(0.25);
const sidePts = [];
for (let k = 0; k < 12; k++) {
  const a = (k / 12) * Math.PI * 2, x = Math.cos(a) * (R + 0.35), z = Math.sin(a) * (R + 0.35);
  sidePts.push(new THREE.Vector3(x, DB_BOTTOM - LAYER_GAP / 2, z), new THREE.Vector3(x, DB_BOTTOM + LAYERS * LAYER_GAP - LAYER_GAP / 2, z));
}
db.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(sidePts), sideMat));
const DBN = LAYERS * PER_LAYER;
const dbSorted = new Float32Array(DBN * 3), dbScatter = new Float32Array(DBN * 3), dbDelay = new Float32Array(DBN), dbLayer = new Int8Array(DBN);
for (let i = 0; i < DBN; i++) {
  const layer = Math.floor(i / PER_LAYER), k = i % PER_LAYER, a = (k / PER_LAYER) * Math.PI * 2 + layer * 0.3;
  const r = R - 0.15 + (rand() - 0.5) * 0.25;
  dbSorted.set([Math.cos(a) * r, DB_BOTTOM + layer * LAYER_GAP, Math.sin(a) * r], i * 3);
  dbScatter.set([(rand() - 0.5) * 3.6, DB_BOTTOM - 0.3 + rand() * (LAYERS * LAYER_GAP), (rand() - 0.5) * 3.6], i * 3);
  dbDelay[i] = rand(); dbLayer[i] = layer;
}
const dbGeo = pointsGeometry(DBN, { sizes: Float32Array.from({ length: DBN }, () => 0.8 + rand() * 0.6), phases: Float32Array.from({ length: DBN }, () => rand() * 6.28) });
const dbMat = glowMaterial(10, true);
db.add(new THREE.Points(dbGeo, dbMat));
const dbLabel = makeLabel("// vector db", 1, rig, 0.9);
dbLabel.sprite.position.set(R + 1.6, -2.3 + 1.9, 0);
// The chunks the LLM will retrieve: a few from the top layers.
const picked = [4, 13, 22, 31, 40, 49].map((k, i) => (LAYERS - 1 - (i % 2)) * PER_LAYER + k);

/* 2c. The LLM core: wireframe shell, neuron sphere, orbit rings */
const core = new THREE.Group();
core.position.set(0, 2.75, 0);
rig.add(core);
const shellMat = lineMaterial(0.5);
const shell = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1.35, 1)), shellMat);
core.add(shell);
const INNER = 300;
const innerPos = new Float32Array(INNER * 3), innerPhase = new Float32Array(INNER), innerSize = new Float32Array(INNER);
for (let i = 0; i < INNER; i++) {
  const y = 1 - (i / (INNER - 1)) * 2, r = Math.sqrt(1 - y * y), th = i * 2.39996, rad = 0.9 + (rand() - 0.5) * 0.12;
  innerPos.set([Math.cos(th) * r * rad, y * rad, Math.sin(th) * r * rad], i * 3);
  innerPhase[i] = rand() * 6.28; innerSize[i] = 0.5 + rand() * 0.6;
}
const innerGeo = pointsGeometry(INNER, { positions: innerPos, sizes: innerSize, phases: innerPhase });
const innerMat = glowMaterial(9, true);
const inner = new THREE.Points(innerGeo, innerMat);
core.add(inner);
const rings = [1.85, 2.2, 2.55].map((radius, i) => {
  const pts = new THREE.EllipseCurve(0, 0, radius, radius).getPoints(128).map((p) => new THREE.Vector3(p.x, p.y, 0));
  const mat = lineMaterial(0.35);
  const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), mat);
  ring.rotation.set(1.1 + i * 0.45, i * 0.8, 0);
  core.add(ring);
  return { ring, mat, speed: (i % 2 ? -1 : 1) * (0.25 + i * 0.12) };
});
const coreLabel = makeLabel("// llm", 2, rig, 0.9);
coreLabel.sprite.position.set(2.5, 2.75 + 1.6, 0);

/* 2d. World-space effects: query beams, retrieval streams, tokens, judge ring */
const beamGeo = new THREE.BufferGeometry();
beamGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(picked.length * 6), 3));
const beamMat = lineMaterial(0.45);
scene.add(new THREE.LineSegments(beamGeo, beamMat));
const PER_STREAM = 6, SP = picked.length * PER_STREAM;
const streamGeo = pointsGeometry(SP);
const streamMat = glowMaterial(11, false);
scene.add(new THREE.Points(streamGeo, streamMat));
const streamT = Float32Array.from({ length: SP }, (_, i) => (i % PER_STREAM) / PER_STREAM);
const TOKENS = small ? 50 : 90;
const tokenGeo = pointsGeometry(TOKENS);
const tokenMat = glowMaterial(10, false);
scene.add(new THREE.Points(tokenGeo, tokenMat));
const tokens = Array.from({ length: TOKENS }, () => ({ t: rand(), lane: rand() * 6.28, speed: 0.16 + rand() * 0.12 }));
const CASES = 24;
const judgeGeo = pointsGeometry(CASES, { sizes: new Float32Array(CASES).fill(1.6) });
const judgeMat = glowMaterial(11, false);
scene.add(new THREE.Points(judgeGeo, judgeMat));

/* ------------------------------------------------------------------ */
/* Palette from the CSS theme                                          */
/* ------------------------------------------------------------------ */
let pal = [];
const C = { pass: new THREE.Color(), fail: new THREE.Color(), idle: new THREE.Color(), haze: new THREE.Color(), paper: "#fff", ink: "#000" };
function applyTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => new THREE.Color(css.getPropertyValue(name).trim() || "#ffffff");
  const light = css.getPropertyValue("--scene-mode").trim() === "light";
  const c1 = v("--cyan"), c2 = v("--violet"), c3 = v("--pink"), c4 = v("--green");
  pal = [c1, c2, c3, c4, c1.clone().lerp(c2, 0.5), c2.clone().lerp(c3, 0.5), c1.clone().lerp(c3, 0.5)];
  C.pass.copy(c4); C.fail.copy(c3); C.idle.set(light ? 0xd6d3d1 : 0x3a4152); C.haze.set(light ? 0xa8a29e : 0x8b93a7);
  shared.uLight.value = light ? 1 : 0;
  const blend = light ? THREE.NormalBlending : THREE.AdditiveBlending;
  [...glowMaterials, ...lineMaterials].forEach((m) => { m.blending = blend; m.needsUpdate = true; });
  const shade = (col, k) => col.clone().lerp(new THREE.Color(light ? 0x000000 : 0xffffff), k);

  for (let i = 0; i < N; i++) {
    const col = clusterOf[i] < 0 ? C.haze : shade(pal[clusterOf[i]], tint[i] * (light ? 0.5 : 1));
    nodeCol.set([col.r, col.g, col.b], i * 3);
  }
  nodeGeo.attributes.color.needsUpdate = true;
  edges.forEach(([a, b], k) => edgeCol.set([nodeCol[a * 3], nodeCol[a * 3 + 1], nodeCol[a * 3 + 2], nodeCol[b * 3], nodeCol[b * 3 + 1], nodeCol[b * 3 + 2]], k * 6));
  edgeGeo.attributes.color.needsUpdate = true;

  const dbc = dbGeo.attributes.color;
  for (let i = 0; i < DBN; i++) { const col = pal[dbLayer[i] % pal.length]; dbc.setXYZ(i, col.r, col.g, col.b); }
  dbc.needsUpdate = true;
  ringMats.forEach((m) => m.color.copy(c2)); sideMat.color.copy(c2);
  const ic = innerGeo.attributes.color;
  for (let i = 0; i < INNER; i++) { const col = pal[i % 3]; ic.setXYZ(i, col.r, col.g, col.b); }
  ic.needsUpdate = true;
  shellMat.color.copy(c2); rings.forEach((r, i) => r.mat.color.copy(pal[i]));
  beamMat.color.copy(c1);
  fill(streamGeo, c1); fill(tokenGeo, c3);

  C.paper = light ? "#ffffff" : "#e9ebf3";
  C.ink = "#" + shade(c2, light ? 0.1 : 0).getHexString();
  stripCanvases.forEach(drawStrip);
  labelSprites.forEach((l) => {
    const ctx = l.cv.getContext("2d");
    ctx.clearRect(0, 0, l.cv.width, l.cv.height);
    ctx.font = "500 44px 'JetBrains Mono', monospace";
    ctx.fillStyle = "#" + shade(pal[l.colorIndex % pal.length], light ? 0.25 : 0).getHexString();
    ctx.fillText(l.text, 8, 62);
    l.tex.needsUpdate = true;
  });
}
// A chunk strip: a slip of paper with a few "lines of text".
function drawStrip({ cv, tex, seed }) {
  const ctx = cv.getContext("2d"), w = cv.width, h = cv.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = C.paper; ctx.globalAlpha = 0.92;
  roundRect(ctx, 2, 2, w - 4, h - 4, 8); ctx.fill();
  ctx.globalAlpha = 1; ctx.strokeStyle = C.ink; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = C.ink;
  const lens = [0.82, 0.64, 0.9, 0.55, 0.75, 0.68];
  ctx.globalAlpha = 0.55;
  roundRect(ctx, 16, 14, (w - 32) * lens[seed % 6], 9, 4); ctx.fill();
  roundRect(ctx, 16, 32, (w - 32) * lens[(seed + 3) % 6] * 0.8, 9, 4); ctx.fill();
  ctx.globalAlpha = 1;
  tex.needsUpdate = true;
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function fill(geo, col) { const a = geo.attributes.color; for (let i = 0; i < a.count; i++) a.setXYZ(i, col.r, col.g, col.b); a.needsUpdate = true; }
applyTheme();

/* ------------------------------------------------------------------ */
/* Story states, one per section                                       */
/* ------------------------------------------------------------------ */
const BASE = { net: 0, nx: 0, ny: 0, nz: -6, ns: 0.6, rot: 0.4, stage: 1, stageS: 1, stageZ: 0, docs: 0, db: 0, sort: 0, core: 0, think: 0, retrieve: 0, tokens: 0, judge: 0 };
const STATES = {
  hero:       { net: 1, nx: 4.2, nz: 0, ns: 1, rot: 1, stage: 0, hud: "embedding space · <b>7 clusters</b> · 665 vectors" },
  about:      { docs: 1, db: 0.7, hud: "ingesting · <b>pages split into chunks</b>" },
  work:       { docs: 0.35, db: 1, sort: 1, hud: "embedding · <b>chunks sorted &amp; stored</b> in the vector DB" },
  experience: { db: 1, sort: 1, core: 1, think: 0.4, hud: "intelligence online · <b>LLM attached</b> to the index" },
  projects:   { db: 1, sort: 1, core: 1, think: 1, retrieve: 1, hud: "LLM <b>querying the vector DB</b> · retrieving context" },
  skills:     { db: 0.8, sort: 1, core: 1, think: 0.5, retrieve: 0.3, tokens: 1, judge: 1, hud: "answering · <b>LLM-as-judge</b> · 95.6% on 191 questions" },
  beyond:     { stage: 0.6, stageS: 0.35, stageZ: -10, db: 0.8, sort: 1, core: 0.8, net: 0.35, ns: 0.5, nz: -8, rot: 0.6, hud: "zooming out · <b>the bigger picture</b>" },
  contact:    { stage: 0, stageS: 0.2, stageZ: -16, net: 0.55, nz: -1, ns: 1.45, rot: 0.5, hud: "ready · <b>awaiting your message</b>" },
};
const READING = new Set(["about", "work", "experience", "projects", "skills", "beyond"]);
const sections = Object.keys(STATES).map((id) => document.getElementById(id)).filter(Boolean);
const P = { ...BASE, ...STATES.hero };
let currentId = "";

function sectionInView() {
  const mid = window.innerHeight * 0.5;
  let id = "hero";
  for (const s of sections) if (s.getBoundingClientRect().top <= mid) id = s.id;
  return id;
}
function setHud(id) {
  if (!hud) return;
  hud.style.opacity = "0";
  setTimeout(() => { hud.innerHTML = STATES[id].hud; hud.style.opacity = "1"; }, 200);
}

/* ------------------------------------------------------------------ */
/* Layout: the stage sits centred in the space right of the text       */
/* ------------------------------------------------------------------ */
let desktop = true, stageX = 0, stageBase = 1;
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.position.z = w > 900 ? 19 : 24;
  camera.updateProjectionMatrix();
  desktop = w >= 1100;
  const halfW = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z * camera.aspect;
  if (desktop) {
    const edge = Math.min(120, Math.max(40, 0.06 * w)) + Math.min(760, 0.54 * w);
    const cx = (edge + w) / 2;
    stageX = ((cx / w) * 2 - 1) * halfW;
    const roomWorld = ((w - edge) / w) * 2 * halfW;
    stageBase = Math.min(1.05, Math.max(0.55, roomWorld / 8.5));
  } else {
    stageX = 0; stageBase = 0.75;
  }
}
window.addEventListener("resize", resize);
resize();

const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
window.addEventListener("pointermove", (e) => {
  pointer.tx = (e.clientX / window.innerWidth - 0.5) * 2;
  pointer.ty = (e.clientY / window.innerHeight - 0.5) * 2;
}, { passive: true });

/* ------------------------------------------------------------------ */
/* Loop                                                                */
/* ------------------------------------------------------------------ */
const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), ctrl = new THREE.Vector3(), coreW = new THREE.Vector3();
const pickedW = picked.map(() => new THREE.Vector3());
let time = 0, last = performance.now(), running = false;

function frame(now) {
  if (document.hidden) { running = false; return; }
  const dt = reduceMotion ? 0 : Math.min((now - last) / 1000, 0.05);
  last = now; time += dt; shared.uTime.value = time;

  const id = sectionInView();
  if (id !== currentId) {
    currentId = id; setHud(id);
    document.documentElement.classList.toggle("scene-reading", READING.has(id));
  }
  const target = { ...BASE, ...STATES[id] };
  const k = reduceMotion ? 1 : 1 - Math.pow(0.03, dt);
  for (const key of Object.keys(BASE)) P[key] += (target[key] - P[key]) * k;
  const dim = desktop ? 1 : 0.6;
  pointer.x += (pointer.tx - pointer.x) * 0.04;
  pointer.y += (pointer.ty - pointer.y) * 0.04;

  /* Main web */
  web.position.set(desktop ? P.nx : 0, desktop ? P.ny : (id === "hero" ? -6.5 : P.ny), P.nz);
  web.scale.setScalar(P.ns * (desktop || id !== "hero" ? 1 : 0.62));
  web.rotation.y += dt * 0.06 * P.rot;
  web.rotation.x = pointer.y * 0.15;
  web.visible = P.net > 0.01;
  nodeMat.uniforms.uOpacity.value = P.net * dim;
  pulseMat.uniforms.uOpacity.value = P.net * dim;
  edgeMat.opacity = edgeMat.userData.base * P.net * dim * (shared.uLight.value ? 1.5 : 1);
  webLabels.forEach((l) => { l.mat.opacity = 0.6 * P.net * dim; });
  if (web.visible) updatePulses(dt);

  /* Stage placement */
  const sv = P.stage * dim;
  stage.visible = sv > 0.01;
  stage.position.set(stageX, desktop ? 0.2 : -2, P.stageZ);
  stage.scale.setScalar(stageBase * P.stageS);
  rig.rotation.y = pointer.x * 0.18 + Math.sin(time * 0.2) * 0.08;
  if (!stage.visible) { hideEffects(); renderer.render(scene, camera); requestAnimationFrame(frame); return; }

  /* Documents: fly in, hold, split into chunks, drop into the database */
  stripMats.forEach((m) => { m.opacity = P.docs * sv; });
  docsLabel.mat.opacity = 0.7 * P.docs * sv;
  const dbTopY = db.position.y + DB_BOTTOM + LAYERS * LAYER_GAP;
  strips.forEach((st) => {
    const t = ((time / 5.5) + st.d * 0.07) % 1;
    const homeX = (st.d - (DOCS - 1) / 2) * (SW + 0.3), homeY = DOC_TOP - st.s * (SH + GAP);
    let x = homeX, y = homeY, z = 0, rz = 0, sx = 1, sy = 1;
    if (t < 0.2) {
      const q = ease(t / 0.2);
      x = homeX + (1 - q) * 3; y = homeY + (1 - q) * 3.5; z = (1 - q) * -2; rz = (1 - q) * 0.6;
    } else if (t < 0.32) {
      // hold as a whole page
    } else if (t < 0.52) {
      const q = ease((t - 0.32) / 0.2);
      x += st.jx * 0.35 * q; y += (st.s - 2.5) * 0.22 * q; z += st.jz * 0.6 * q; rz = st.jr * q; sx = 1 - 0.25 * q;
    } else if (t < 0.84) {
      const q = ease((t - 0.52) / 0.32);
      const fx = homeX + st.jx * 0.35, fy = homeY + (st.s - 2.5) * 0.22, fz = st.jz * 0.6;
      x = fx + (st.jx * 0.9 - fx) * q; y = fy + (dbTopY - fy) * q; z = fz + (st.jz * 0.9 - fz) * q;
      rz = st.jr * (1 - q); sx = sy = (1 - q) * 0.75 + 0.02;
    } else {
      sx = sy = 0.0001;
    }
    st.mesh.position.set(x, y, z);
    st.mesh.rotation.set(0, 0, rz);
    st.mesh.scale.set(sx, sy, 1);
    st.mesh.visible = P.docs > 0.01;
  });

  /* Vector database: chunks sort into colour layers */
  db.rotation.y += dt * 0.15;
  const dbV = P.db * sv;
  ringMats.forEach((m) => { m.opacity = m.userData.base * dbV; });
  sideMat.opacity = sideMat.userData.base * dbV;
  dbMat.uniforms.uOpacity.value = dbV;
  dbLabel.mat.opacity = 0.7 * dbV;
  const dp = dbGeo.attributes.position;
  for (let i = 0; i < DBN; i++) {
    const s = ease(P.sort * 1.6 - dbDelay[i] * 0.6);
    dp.setXYZ(i,
      dbScatter[i * 3] + (dbSorted[i * 3] - dbScatter[i * 3]) * s,
      dbScatter[i * 3 + 1] + (dbSorted[i * 3 + 1] - dbScatter[i * 3 + 1]) * s,
      dbScatter[i * 3 + 2] + (dbSorted[i * 3 + 2] - dbScatter[i * 3 + 2]) * s);
  }
  dp.needsUpdate = true;

  /* LLM core */
  const coreV = P.core * sv;
  core.scale.setScalar(Math.max(0.001, P.core) * (1 + P.think * 0.08 * Math.sin(time * 5)));
  shell.rotation.y += dt * (0.2 + P.think * 1.2);
  shell.rotation.x += dt * (0.1 + P.think * 0.5);
  inner.rotation.y -= dt * (0.3 + P.think * 2);
  shellMat.opacity = shellMat.userData.base * coreV * (0.7 + P.think * 0.3);
  innerMat.uniforms.uOpacity.value = coreV;
  innerMat.uniforms.uSize.value = 9 * (1 + P.think * 0.35 * (0.5 + 0.5 * Math.sin(time * 8)));
  rings.forEach((r) => { r.ring.rotation.z += dt * r.speed * (0.4 + P.think * 3); r.mat.opacity = r.mat.userData.base * coreV * (0.5 + P.think * 0.5); });
  coreLabel.mat.opacity = 0.7 * coreV;

  /* Interaction: beams from the core to picked chunks, chunks rising into the core */
  stage.updateMatrixWorld(true);
  core.getWorldPosition(coreW);
  picked.forEach((idx, i) => pickedW[i].set(dp.getX(idx), dp.getY(idx), dp.getZ(idx)).applyMatrix4(db.matrixWorld));
  const bp = beamGeo.attributes.position;
  picked.forEach((_, i) => { bp.setXYZ(i * 2, coreW.x, coreW.y, coreW.z); bp.setXYZ(i * 2 + 1, pickedW[i].x, pickedW[i].y, pickedW[i].z); });
  bp.needsUpdate = true;
  beamMat.opacity = beamMat.userData.base * P.retrieve * sv * (0.6 + 0.4 * Math.sin(time * 6));
  const sp = streamGeo.attributes.position, ss = streamGeo.attributes.size;
  for (let i = 0; i < SP; i++) {
    const s = Math.floor(i / PER_STREAM);
    streamT[i] = (streamT[i] + dt * 0.45) % 1;
    const t = streamT[i];
    ctrl.copy(pickedW[s]).lerp(coreW, 0.5).add(tmp.set((s - 2.5) * 0.5 * stageBase, 0, 1));
    quadBezier(pickedW[s], ctrl, coreW, t, tmp2);
    sp.setXYZ(i, tmp2.x, tmp2.y, tmp2.z);
    ss.setX(i, 1.3 * Math.sin(Math.PI * t));
  }
  sp.needsUpdate = true; ss.needsUpdate = true;
  streamMat.uniforms.uOpacity.value = P.retrieve * sv;

  /* Answer: tokens spiral out of the core */
  const tp = tokenGeo.attributes.position, ts = tokenGeo.attributes.size;
  const spread = stageBase * Math.max(0.2, P.stageS);
  tokens.forEach((tk, i) => {
    tk.t = (tk.t + dt * tk.speed) % 1;
    const t = tk.t, a = tk.lane + t * 5;
    tp.setXYZ(i, coreW.x + Math.cos(a) * (1.2 + t * 3.2) * spread, coreW.y + (Math.sin(a) * (1.2 + t * 2.4) + t * 2) * spread, coreW.z + Math.sin(a * 0.7) * spread);
    ts.setX(i, 1.3 * (1 - t) * Math.min(1, t * 8));
  });
  tp.needsUpdate = true; ts.needsUpdate = true;
  tokenMat.uniforms.uOpacity.value = P.tokens * sv;

  /* Judge ring: one case fails, 95.6% is not 100% */
  const jp = judgeGeo.attributes.position, jc = judgeGeo.attributes.color, js = judgeGeo.attributes.size;
  const judged = Math.floor((time * 5) % (CASES + 10));
  for (let i = 0; i < CASES; i++) {
    const a = (i / CASES) * Math.PI * 2 + Math.PI / 2, r = 3.1 * spread * Math.max(0.001, P.judge);
    jp.setXYZ(i, coreW.x + Math.cos(a) * r, coreW.y + Math.sin(a) * r, coreW.z + 0.5);
    const col = i < judged ? (i === 17 ? C.fail : C.pass) : C.idle;
    jc.setXYZ(i, col.r, col.g, col.b);
    js.setX(i, i === judged - 1 ? 2.6 : 1.6);
  }
  jp.needsUpdate = true; jc.needsUpdate = true; js.needsUpdate = true;
  judgeMat.uniforms.uOpacity.value = P.judge * sv;

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
function hideEffects() {
  beamMat.opacity = 0;
  [streamMat, tokenMat, judgeMat].forEach((m) => { m.uniforms.uOpacity.value = 0; });
}

function updatePulses(dt) {
  const pp = pulseGeo.attributes.position, pc = pulseGeo.attributes.color;
  pulses.forEach((p, i) => {
    p.t += dt * p.speed;
    if (p.t >= 1) {
      const [a, b] = edges[p.edge], node = p.from === a ? b : a;
      const options = adjacency[node].filter((e) => e !== p.edge);
      p.edge = options.length ? options[Math.floor(Math.random() * options.length)] : Math.floor(Math.random() * edges.length);
      p.from = options.length ? node : edges[p.edge][0];
      p.t = 0;
    }
    const [a, b] = edges[p.edge], to = p.from === a ? b : a;
    tmp.copy(vecAt(nodePos, p.from)).lerp(vecAt(nodePos, to), p.t);
    pp.setXYZ(i, tmp.x, tmp.y, tmp.z);
    const c = pal[clusterOf[to]] || pal[0];
    if (shared.uLight.value) pc.setXYZ(i, c.r * 0.8, c.g * 0.8, c.b * 0.8);
    else pc.setXYZ(i, 0.6 + c.r * 0.6, 0.6 + c.g * 0.6, 0.6 + c.b * 0.6);
  });
  pp.needsUpdate = true; pc.needsUpdate = true;
}

function start() {
  if (running || document.hidden) return;
  running = true; last = performance.now();
  requestAnimationFrame(frame);
}
document.addEventListener("visibilitychange", start);
start();

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function vecAt(arr, i) { return new THREE.Vector3(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]); }
function quadBezier(a, c, b, t, out) {
  const u = 1 - t;
  return out.set(u * u * a.x + 2 * u * t * c.x + t * t * b.x, u * u * a.y + 2 * u * t * c.y + t * t * b.y, u * u * a.z + 2 * u * t * c.z + t * t * b.z);
}
// Small seeded PRNG so the layout looks the same on every visit.
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
})();
