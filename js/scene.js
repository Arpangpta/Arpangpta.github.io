// Background 3D story. Content scrolls in the left column; the story plays on the
// right. AI components (documents, vector DB, LLM, MCP server, agents, evaluator)
// wait greyed out in a dock behind the text and get dragged onto the stage, in
// colour, when the section that uses them comes into view:
//   hero        the main web: an embedding space of clustered vectors
//   about       ingest: pages split into chunks that drop into the vector DB
//   work        RAG: chunks sort into layers, the LLM arrives and retrieves context
//   experience  MCP: the LLM commands tools through an MCP server
//   projects    agentic: planner, researcher, executor, reviewer pass a task around
//   skills      evaluate: tokens stream out, an LLM-as-judge ring scores them
//   beyond      map-style zoom out: everything shrinks into one point
//   contact     the whole web, full screen, in the background
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
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 160);
camera.position.set(0, 0, 19);

const rand = mulberry32(7);
const gauss = () => { let u = 0, v = 0; while (!u) u = rand(); while (!v) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const ease = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
const lerp = (a, b, t) => a + (b - a) * t;

/* ================================================================== */
/* Materials                                                          */
/* ================================================================== */
const shared = { uTime: { value: 0 }, uPixelRatio: { value: renderer.getPixelRatio() }, uLight: { value: 0 }, uGreyCol: { value: new THREE.Color(0x888888) } };
const glowMaterials = [];
function glowMaterial(size, twinkle) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...shared, uOpacity: { value: 1 }, uSize: { value: size }, uTwinkle: { value: twinkle ? 1 : 0 }, uGrey: { value: 0 } },
    vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute float size; attribute float phase;
      uniform float uTime, uPixelRatio, uTwinkle, uSize, uLight, uGrey;
      uniform vec3 uGreyCol;
      varying vec3 vColor; varying float vTw; varying float vSoft;
      void main() {
        vColor = mix(color, uGreyCol, uGrey);
        vSoft = uGrey;
        vTw = mix(1.0, 0.65 + 0.35 * sin(uTime * 1.6 + phase), uTwinkle);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = uSize * size * mix(1.0, 0.72, uLight) * (1.0 + uGrey * 0.6) * uPixelRatio * (12.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float uOpacity, uLight;
      varying vec3 vColor; varying float vTw; varying float vSoft;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        float core = smoothstep(0.5, 0.0, d);
        float glow = pow(core, 2.2);
        vec3 col = mix(vColor * (0.6 + glow), vColor, uLight);
        // Docked (grey) components use a soft falloff so they read as out of focus.
        float crisp = smoothstep(0.5, 0.3, d) * 0.9;
        float a = mix(glow, mix(crisp, core * 0.7, vSoft), uLight);
        gl_FragColor = vec4(col, a * vTw * uOpacity);
      }`,
  });
  mat.userData.gate = 1;
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
  m.userData.base = base; m.userData.gate = 1; m.userData.col = new THREE.Color(0xffffff);
  lineMaterials.push(m);
  return m;
}
const labelSprites = [];
function makeLabel(text, colorIndex, parent, scale = 1) {
  const cv = document.createElement("canvas"); cv.width = 512; cv.height = 96;
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  mat.userData.base = 0.75; mat.userData.gate = 1;
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2.8 * scale, 0.525 * scale, 1);
  parent.add(sprite);
  const label = { cv, tex, mat, sprite, text, colorIndex };
  labelSprites.push(label);
  return label;
}

/* ================================================================== */
/* Main web: embedding space                                          */
/* ================================================================== */
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

/* ================================================================== */
/* Components                                                         */
/* ================================================================== */
// Each component: a group in world space that moves between its dock slot
// (left, grey) and a stage slot (right, colour). a = how "active" it is.
const comps = {};
function component(name, dockSlot) {
  const group = new THREE.Group();
  scene.add(group);
  const c = { name, group, dockSlot, glows: [], lines: [], meshes: [], labels: [], a: 0, vis: 0, local: new THREE.Vector3(), lscale: 1, pos: new THREE.Vector3(), scale: 0.4 };
  comps[name] = c;
  return c;
}
const own = (c, kind, m) => { c[kind].push(m); return m; };

/* ---- Documents: pages that split into chunk strips ---- */
const docs = component("docs", [0.1, 0.2]);
const DOCS = 3, STRIPS = 6, SW = 1.2, SH = 0.26, GAP = 0.05;
const stripGeo = new THREE.PlaneGeometry(SW, SH);
const stripCanvases = [], stripMats = [];
for (let s = 0; s < STRIPS; s++) {
  const cv = document.createElement("canvas"); cv.width = 240; cv.height = 52;
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  stripCanvases.push({ cv, tex, seed: s });
  const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  m.userData.base = 1; m.userData.gate = 1;
  stripMats.push(own(docs, "meshes", m));
}
const strips = [];
for (let d = 0; d < DOCS; d++) for (let s = 0; s < STRIPS; s++) {
  const mesh = new THREE.Mesh(stripGeo, stripMats[s]);
  docs.group.add(mesh);
  strips.push({ mesh, d, s, jx: (rand() - 0.5) * 2, jz: (rand() - 0.5) * 2, jr: (rand() - 0.5) * 0.9 });
}
const docsLabel = makeLabel("// documents", 0, docs.group, 0.85); own(docs, "labels", docsLabel.mat); docsLabel.sprite.position.set(0, 1.25, 0);

/* ---- Vector DB: stacked rings, chunks sorted by colour into layers ---- */
const vdb = component("db", [0.3, 0.3]);
const dbTilt = new THREE.Group(); dbTilt.rotation.x = 0.32; vdb.group.add(dbTilt);
const dbSpin = new THREE.Group(); dbTilt.add(dbSpin);
const LAYERS = 5, PER_LAYER = 50, R = 1.7, LAYER_GAP = 0.55, DB_BOTTOM = -1.1;
for (let i = 0; i <= LAYERS; i++) {
  const y = DB_BOTTOM + i * LAYER_GAP - LAYER_GAP / 2;
  const pts = Array.from({ length: 97 }, (_, k) => { const a = (k / 96) * Math.PI * 2; return new THREE.Vector3(Math.cos(a) * (R + 0.3), y, Math.sin(a) * (R + 0.3)); });
  dbSpin.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), own(vdb, "lines", lineMaterial(i === 0 || i === LAYERS ? 0.55 : 0.25))));
}
const sidePts = [];
for (let k = 0; k < 12; k++) {
  const a = (k / 12) * Math.PI * 2, x = Math.cos(a) * (R + 0.3), z = Math.sin(a) * (R + 0.3);
  sidePts.push(new THREE.Vector3(x, DB_BOTTOM - LAYER_GAP / 2, z), new THREE.Vector3(x, DB_BOTTOM + LAYERS * LAYER_GAP - LAYER_GAP / 2, z));
}
dbSpin.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(sidePts), own(vdb, "lines", lineMaterial(0.25))));
const DBN = LAYERS * PER_LAYER;
const dbSorted = new Float32Array(DBN * 3), dbScatter = new Float32Array(DBN * 3), dbDelay = new Float32Array(DBN), dbLayer = new Int8Array(DBN);
for (let i = 0; i < DBN; i++) {
  const layer = Math.floor(i / PER_LAYER), k = i % PER_LAYER, a = (k / PER_LAYER) * Math.PI * 2 + layer * 0.3, r = R - 0.15 + (rand() - 0.5) * 0.22;
  dbSorted.set([Math.cos(a) * r, DB_BOTTOM + layer * LAYER_GAP, Math.sin(a) * r], i * 3);
  dbScatter.set([(rand() - 0.5) * 3.2, DB_BOTTOM - 0.3 + rand() * (LAYERS * LAYER_GAP), (rand() - 0.5) * 3.2], i * 3);
  dbDelay[i] = rand(); dbLayer[i] = layer;
}
const dbGeo = pointsGeometry(DBN, { sizes: Float32Array.from({ length: DBN }, () => 0.8 + rand() * 0.6), phases: Float32Array.from({ length: DBN }, () => rand() * 6.28) });
const dbPoints = new THREE.Points(dbGeo, own(vdb, "glows", glowMaterial(10, true)));
dbSpin.add(dbPoints);
const dbLabelSprite = makeLabel("// vector db", 1, vdb.group, 0.85);
own(vdb, "labels", dbLabelSprite.mat); dbLabelSprite.sprite.position.set(R + 1.3, 1.6, 0);
const picked = [4, 12, 21, 29, 38, 46].map((k, i) => (LAYERS - 1 - (i % 2)) * PER_LAYER + k);
const DB_TOP_LOCAL = DB_BOTTOM + LAYERS * LAYER_GAP;

/* ---- LLM core ---- */
const llm = component("llm", [0.17, 0.52]);
const shell = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1.25, 1)), own(llm, "lines", lineMaterial(0.5)));
llm.group.add(shell);
const INNER = 280;
const innerPos = new Float32Array(INNER * 3), innerPhase = new Float32Array(INNER), innerSize = new Float32Array(INNER);
for (let i = 0; i < INNER; i++) {
  const y = 1 - (i / (INNER - 1)) * 2, r = Math.sqrt(1 - y * y), th = i * 2.39996, rad = 0.85 + (rand() - 0.5) * 0.12;
  innerPos.set([Math.cos(th) * r * rad, y * rad, Math.sin(th) * r * rad], i * 3);
  innerPhase[i] = rand() * 6.28; innerSize[i] = 0.5 + rand() * 0.6;
}
const innerGeo = pointsGeometry(INNER, { positions: innerPos, sizes: innerSize, phases: innerPhase });
const innerMat = own(llm, "glows", glowMaterial(9, true));
const inner = new THREE.Points(innerGeo, innerMat);
llm.group.add(inner);
const llmRings = [1.7, 2.0, 2.3].map((radius, i) => {
  const pts = new THREE.EllipseCurve(0, 0, radius, radius).getPoints(128).map((p) => new THREE.Vector3(p.x, p.y, 0));
  const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), own(llm, "lines", lineMaterial(0.35)));
  ring.rotation.set(1.1 + i * 0.45, i * 0.8, 0);
  llm.group.add(ring);
  return { ring, speed: (i % 2 ? -1 : 1) * (0.25 + i * 0.12) };
});
const llmLabel = makeLabel("// llm", 2, llm.group, 0.85); own(llm, "labels", llmLabel.mat); llmLabel.sprite.position.set(2.1, 1.5, 0);

/* ---- MCP server: a hub that routes commands to tools ---- */
const mcp = component("mcp", [0.38, 0.6]);
const hub = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.CylinderGeometry(0.75, 0.75, 0.45, 6)), own(mcp, "lines", lineMaterial(0.8)));
hub.rotation.x = 0.5;
mcp.group.add(hub);
const hubCoreMat = own(mcp, "glows", glowMaterial(14, true));
const hubCore = new THREE.Points(pointsGeometry(1, { sizes: new Float32Array([2.4]) }), hubCoreMat);
mcp.group.add(hubCore);
const TOOL_NAMES = ["crm", "search", "tickets", "files"];
const tools = TOOL_NAMES.map((name, i) => {
  const ang = Math.PI / 4 + (i * Math.PI) / 2;
  const g = new THREE.Group();
  g.position.set(Math.cos(ang) * 1.9, Math.sin(ang) * 1.5, 0);
  mcp.group.add(g);
  const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(0.5, 0.5, 0.5)), own(mcp, "lines", lineMaterial(0.75)));
  g.add(box);
  const ringPts = new THREE.EllipseCurve(0, 0, 0.5, 0.5, Math.PI / 2, Math.PI / 2 - Math.PI * 2, true).getPoints(48).map((p) => new THREE.Vector3(p.x, p.y, 0));
  const progress = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPts), own(mcp, "lines", lineMaterial(0.9)));
  progress.geometry.setDrawRange(0, 0);
  g.add(progress);
  const lab = makeLabel(name, 3 + i, g, 0.55); own(mcp, "labels", lab.mat); lab.sprite.position.set(0.85, 0.42, 0);
  return { g, box, progress, ang };
});
const spokePts = [];
tools.forEach((t) => spokePts.push(new THREE.Vector3(0, 0, 0), t.g.position.clone()));
mcp.group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(spokePts), own(mcp, "lines", lineMaterial(0.22))));
const mcpLabel = makeLabel("// mcp server", 4, mcp.group, 0.85); own(mcp, "labels", mcpLabel.mat); mcpLabel.sprite.position.set(0, -1.15, 0);

/* ---- Agents: planner, researcher, executor, reviewer around an orchestrator ---- */
const agents = component("agents", [0.12, 0.82]);
const agentTilt = new THREE.Group(); agentTilt.rotation.x = 0.55; agents.group.add(agentTilt);
const AGENT_NAMES = ["planner", "researcher", "executor", "reviewer"];
const AR = 2.0;
const orch = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.OctahedronGeometry(0.45)), own(agents, "lines", lineMaterial(0.8)));
agentTilt.add(orch);
const orbitPts = new THREE.EllipseCurve(0, 0, AR, AR).getPoints(96).map((p) => new THREE.Vector3(p.x, 0, p.y));
agentTilt.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(orbitPts), own(agents, "lines", lineMaterial(0.25))));
const agentGeo = pointsGeometry(4, { sizes: new Float32Array(4).fill(2.6) });
const agentMat = own(agents, "glows", glowMaterial(12, false));
agentTilt.add(new THREE.Points(agentGeo, agentMat));
const agentLinkGeo = new THREE.BufferGeometry();
agentLinkGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(8 * 3), 3));
agentTilt.add(new THREE.LineSegments(agentLinkGeo, own(agents, "lines", lineMaterial(0.25))));
const batonGeo = pointsGeometry(6, { sizes: Float32Array.from([2, 1.6, 1.3, 1, 0.8, 0.6]) });
const batonMat = own(agents, "glows", glowMaterial(12, false));
agentTilt.add(new THREE.Points(batonGeo, batonMat));
const agentLabels = AGENT_NAMES.map((name, i) => { const l = makeLabel(name, i, agentTilt, 0.55); own(agents, "labels", l.mat); return l; });
const agentsLabel = makeLabel("// agentic workflow", 5, agents.group, 0.85); own(agents, "labels", agentsLabel.mat); agentsLabel.sprite.position.set(0, -1.9, 0);

/* ---- Evaluator: LLM-as-judge ring ---- */
const judge = component("judge", [0.33, 0.86]);
const CASES = 24;
const judgeGeo = pointsGeometry(CASES, { sizes: new Float32Array(CASES).fill(1.6) });
for (let i = 0; i < CASES; i++) { const a = (i / CASES) * Math.PI * 2 + Math.PI / 2; judgeGeo.attributes.position.setXYZ(i, Math.cos(a) * 2.7, Math.sin(a) * 2.7, 0.4); }
judge.group.add(new THREE.Points(judgeGeo, own(judge, "glows", glowMaterial(11, false))));
const judgeLabel = makeLabel("// llm-as-judge", 3, judge.group, 0.85); own(judge, "labels", judgeLabel.mat); judgeLabel.sprite.position.set(2.3, -2.7, 0);

/* ---- World-space effects: beams, packets, tokens ---- */
const beamGeo = new THREE.BufferGeometry();
beamGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(picked.length * 6), 3));
const beamMat = lineMaterial(0.45);
scene.add(new THREE.LineSegments(beamGeo, beamMat));
const PER_STREAM = 6, SP = picked.length * PER_STREAM;
const streamGeo = pointsGeometry(SP);
const streamMat = glowMaterial(11, false);
scene.add(new THREE.Points(streamGeo, streamMat));
const streamT = Float32Array.from({ length: SP }, (_, i) => (i % PER_STREAM) / PER_STREAM);
// MCP command packet (with a short trail) and the LLM-to-hub link.
const TRAIL = 7;
const packetGeo = pointsGeometry(TRAIL, { sizes: Float32Array.from({ length: TRAIL }, (_, i) => 2.2 * (1 - i / TRAIL) + 0.3) });
const packetMat = glowMaterial(12, false);
scene.add(new THREE.Points(packetGeo, packetMat));
const packetHist = Array.from({ length: TRAIL }, () => new THREE.Vector3());
const linkGeo = new THREE.BufferGeometry();
linkGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3));
const linkMat = lineMaterial(0.35);
scene.add(new THREE.LineSegments(linkGeo, linkMat));
const TOKENS = small ? 50 : 90;
const tokenGeo = pointsGeometry(TOKENS);
const tokenMat = glowMaterial(10, false);
scene.add(new THREE.Points(tokenGeo, tokenMat));
const tokens = Array.from({ length: TOKENS }, () => ({ t: rand(), lane: rand() * 6.28, speed: 0.16 + rand() * 0.12 }));

/* ================================================================== */
/* Palette                                                            */
/* ================================================================== */
let pal = [];
const C = { pass: new THREE.Color(), fail: new THREE.Color(), idle: new THREE.Color(), haze: new THREE.Color(), grey: new THREE.Color(), paper: "#fff", ink: "#000" };
function applyTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => new THREE.Color(css.getPropertyValue(name).trim() || "#ffffff");
  const light = css.getPropertyValue("--scene-mode").trim() === "light";
  const c1 = v("--cyan"), c2 = v("--violet"), c3 = v("--pink"), c4 = v("--green");
  pal = [c1, c2, c3, c4, c1.clone().lerp(c2, 0.5), c2.clone().lerp(c3, 0.5), c1.clone().lerp(c3, 0.5)];
  C.pass.copy(c4); C.fail.copy(c3);
  C.idle.set(light ? 0xd6d3d1 : 0x3a4152); C.haze.set(light ? 0xa8a29e : 0x8b93a7); C.grey.set(light ? 0xa8a29e : 0x5b6273);
  shared.uGreyCol.value.copy(C.grey);
  shared.uLight.value = light ? 1 : 0;
  const blend = light ? THREE.NormalBlending : THREE.AdditiveBlending;
  [...glowMaterials, ...lineMaterials].forEach((m) => { m.blending = blend; m.needsUpdate = true; });
  const shade = (col, k) => col.clone().lerp(new THREE.Color(light ? 0x000000 : 0xffffff), k);

  for (let i = 0; i < N; i++) { const col = clusterOf[i] < 0 ? C.haze : shade(pal[clusterOf[i]], tint[i] * (light ? 0.5 : 1)); nodeCol.set([col.r, col.g, col.b], i * 3); }
  nodeGeo.attributes.color.needsUpdate = true;
  edges.forEach(([a, b], k) => edgeCol.set([nodeCol[a * 3], nodeCol[a * 3 + 1], nodeCol[a * 3 + 2], nodeCol[b * 3], nodeCol[b * 3 + 1], nodeCol[b * 3 + 2]], k * 6));
  edgeGeo.attributes.color.needsUpdate = true;

  const setCols = (geo, fn) => { const a = geo.attributes.color; for (let i = 0; i < a.count; i++) { const col = fn(i); a.setXYZ(i, col.r, col.g, col.b); } a.needsUpdate = true; };
  setCols(dbGeo, (i) => pal[dbLayer[i] % pal.length]);
  setCols(innerGeo, (i) => pal[i % 3]);
  setCols(agentGeo, (i) => pal[i]);
  setCols(batonGeo, () => c3);
  setCols(streamGeo, () => c1); setCols(tokenGeo, () => c3); setCols(packetGeo, () => c1);
  setCols(hubCore.geometry, () => c4);
  comps.db.lines.forEach((m) => m.userData.col.copy(c2));
  comps.llm.lines.forEach((m, i) => m.userData.col.copy(i === 0 ? c2 : pal[(i - 1) % 3]));
  comps.mcp.lines.forEach((m) => m.userData.col.copy(c4));
  comps.agents.lines.forEach((m) => m.userData.col.copy(c2));
  beamMat.userData.col.copy(c1); linkMat.userData.col.copy(c1);
  [beamMat, linkMat].forEach((m) => m.color.copy(m.userData.col));

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
function drawStrip({ cv, tex, seed }) {
  const ctx = cv.getContext("2d"), w = cv.width, h = cv.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = C.paper; ctx.globalAlpha = 0.92;
  roundRect(ctx, 2, 2, w - 4, h - 4, 8); ctx.fill();
  ctx.globalAlpha = 1; ctx.strokeStyle = C.ink; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = C.ink; ctx.globalAlpha = 0.55;
  const lens = [0.82, 0.64, 0.9, 0.55, 0.75, 0.68];
  roundRect(ctx, 14, 12, (w - 28) * lens[seed % 6], 9, 4); ctx.fill();
  roundRect(ctx, 14, 30, (w - 28) * lens[(seed + 3) % 6] * 0.8, 9, 4); ctx.fill();
  ctx.globalAlpha = 1;
  tex.needsUpdate = true;
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
applyTheme();

/* ================================================================== */
/* Story: which components are on stage, and where, per section       */
/* ================================================================== */
// on: { component: [x, y, scale] } in stage units (stage is about 8 x 9).
const STATES = {
  hero:       { web: { net: 1, x: "hero", ns: 1, nz: 0 }, dock: 0, on: {}, hud: "embedding space · <b>7 clusters</b> · 665 vectors" },
  about:      { on: { docs: [0, 2.6, 1], db: [0, -1.9, 1] }, fx: { ingest: 1 }, hud: "ingesting · <b>pages split into chunks</b> for the vector DB" },
  work:       { on: { db: [0, -1.9, 1], llm: [0, 2.2, 0.9] }, fx: { sort: 1, retrieve: 1, think: 0.6 }, hud: "RAG · <b>LLM retrieving context</b> from the vector DB" },
  experience: { on: { llm: [0, 2.2, 0.9], mcp: [0, -1.8, 1] }, fx: { sort: 1, mcp: 1, think: 0.7 }, hud: "MCP · <b>LLM commanding tools</b> through the MCP server" },
  projects:   { on: { llm: [0, 2.9, 0.65], agents: [0, -0.2, 0.95], mcp: [0, -3.2, 0.55] }, fx: { sort: 1, agents: 1, think: 1 }, hud: "agentic · <b>planner → researcher → executor → reviewer</b>" },
  skills:     { on: { llm: [0, 0.4, 1.05], judge: [0, 0.4, 1.05] }, fx: { sort: 1, tokens: 1, judge: 1, think: 0.5 }, hud: "evaluating · <b>LLM-as-judge</b> · 95.6% on 191 questions" },
  beyond:     { web: { net: 0.7, x: "anchor", ns: 0.28, nz: -2 }, zoom: 1, fx: { sort: 1 }, hud: "zooming out · <b>the bigger picture</b>" },
  contact:    { web: { net: 0.55, x: 0, ns: 1.45, nz: -1 }, zoom: 1, dock: 0, fx: { sort: 1 }, hud: "the whole system · <b>ready for your message</b>" },
};
const READING = new Set(["about", "work", "experience", "projects", "skills", "beyond"]);
const sections = Object.keys(STATES).map((id) => document.getElementById(id)).filter(Boolean);
const FX = { ingest: 0, sort: 0, retrieve: 0, think: 0, mcp: 0, agents: 0, tokens: 0, judge: 0 };
const W = { net: 1, x: 4.2, ns: 1, nz: 0 };
let zoomP = 0, dockV = 0, currentId = "";

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

/* ================================================================== */
/* Layout                                                             */
/* ================================================================== */
let desktop = true, stageBase = 1, heroX = 4.2;
const anchor = new THREE.Vector3();
function frustumHalf(z) { const h = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * (camera.position.z - z); return [h * camera.aspect, h]; }
function screenToWorld(fx, fy, z, out) { const [hw, hh] = frustumHalf(z); return out.set((fx * 2 - 1) * hw, (1 - fy * 2) * hh, z); }
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.position.z = w > 900 ? 19 : 24;
  camera.updateProjectionMatrix();
  desktop = w >= 1100;
  if (desktop) {
    const edge = Math.min(120, Math.max(40, 0.06 * w)) + Math.min(860, 0.58 * w);
    screenToWorld(((edge + w) / 2 + 20) / w, 0.52, 0, anchor);
    // Fill the space right of the text: limited by its width and by the screen height.
    const [hw, hh] = frustumHalf(0);
    const byWidth = (((w - edge) / w) * 2 * hw) / 7.2;
    const byHeight = (2 * hh * 0.9) / 8.6;
    stageBase = Math.min(1.75, Math.max(0.6, Math.min(byWidth, byHeight)));
    heroX = 4.2;
  } else {
    anchor.set(0, -3, 0); stageBase = 0.7; heroX = 0;
  }
  Object.values(comps).forEach((c) => { c.dock = screenToWorld(c.dockSlot[0], c.dockSlot[1], -3, new THREE.Vector3()); });
}
window.addEventListener("resize", resize);
resize();

const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
window.addEventListener("pointermove", (e) => { pointer.tx = (e.clientX / window.innerWidth - 0.5) * 2; pointer.ty = (e.clientY / window.innerHeight - 0.5) * 2; }, { passive: true });

/* ================================================================== */
/* Loop                                                               */
/* ================================================================== */
const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), ctrl = new THREE.Vector3(), stageW = new THREE.Vector3();
const llmW = new THREE.Vector3(), hubW = new THREE.Vector3(), toolW = tools.map(() => new THREE.Vector3()), execW = new THREE.Vector3();
const pickedW = picked.map(() => new THREE.Vector3());
let time = 0, last = performance.now(), running = false;

function frame(now) {
  if (document.hidden) { running = false; return; }
  // rAF timestamps can be slightly earlier than performance.now(), so never step backwards.
  const dt = reduceMotion ? 0 : Math.min(Math.max(0, (now - last) / 1000), 0.05);
  last = now; time += dt; shared.uTime.value = time;
  const k = reduceMotion ? 1 : 1 - Math.pow(0.04, dt);   // smoothing toward targets
  const kSlow = reduceMotion ? 1 : 1 - Math.pow(0.12, dt);

  const id = sectionInView();
  if (id !== currentId) { currentId = id; setHud(id); document.documentElement.classList.toggle("scene-reading", READING.has(id)); }
  const st = STATES[id];
  for (const key of Object.keys(FX)) FX[key] += (((st.fx || {})[key] || 0) - FX[key]) * k;
  zoomP += ((st.zoom || 0) - zoomP) * kSlow;
  dockV += (((st.dock ?? 1) && desktop ? 1 : 0) - dockV) * k;
  pointer.x += (pointer.tx - pointer.x) * 0.04; pointer.y += (pointer.ty - pointer.y) * 0.04;

  /* ---- Main web ---- */
  const ws = st.web || { net: 0, x: "anchor", ns: 0.2, nz: -2 };
  const tx = ws.x === "hero" ? heroX : ws.x === "anchor" ? anchor.x : ws.x;
  W.net += (ws.net - W.net) * kSlow; W.x += (tx - W.x) * kSlow; W.ns += (ws.ns - W.ns) * kSlow; W.nz += (ws.nz - W.nz) * kSlow;
  const mobileHero = !desktop && id === "hero";
  web.position.set(W.x, mobileHero ? -6.5 : (ws.x === "anchor" ? anchor.y * (1 - zoomP) : 0), W.nz);
  web.scale.setScalar(W.ns * (mobileHero ? 0.62 : 1));
  web.rotation.y += dt * 0.06 * (0.4 + W.net * 0.6);
  web.rotation.x = pointer.y * 0.15;
  web.visible = W.net > 0.01;
  const wdim = desktop ? 1 : 0.6;
  nodeMat.uniforms.uOpacity.value = W.net * wdim; pulseMat.uniforms.uOpacity.value = W.net * wdim;
  edgeMat.opacity = edgeMat.userData.base * W.net * wdim * (shared.uLight.value ? 1.5 : 1);
  webLabels.forEach((l) => { l.mat.opacity = 0.6 * W.net * wdim; });
  if (web.visible) updatePulses(dt);

  /* ---- Components: dock (grey, left) <-> stage (colour, right) ---- */
  const inStory = id !== "hero";
  Object.values(comps).forEach((c) => {
    const slot = (st.on || {})[c.name];
    const targetA = slot ? 1 : 0;
    c.a += (targetA - c.a) * k;
    if (slot) { c.local.x += (slot[0] - c.local.x) * k; c.local.y += (slot[1] - c.local.y) * k; c.lscale += (slot[2] - c.lscale) * k; }
    const targetVis = inStory ? (slot ? 1 : dockV) : 0;
    c.vis += (targetVis * (1 - zoomP * 0.98) - c.vis) * k;
    c.group.visible = c.vis > 0.01;
    if (!c.group.visible) return;

    // Stage position, and the "drag" path from the dock: lifted toward the viewer mid-way.
    stageW.set(anchor.x + c.local.x * stageBase, anchor.y + c.local.y * stageBase, anchor.z);
    stageW.lerp(anchor, zoomP);                          // zoom out: everything converges
    const a = ease(c.a);
    ctrl.copy(c.dock).lerp(stageW, 0.5).add(tmp.set(0, 1.5, 4));
    quadBezier(c.dock, ctrl, stageW, a, c.pos);
    c.group.position.copy(c.pos);
    const s = lerp(0.6, c.lscale * stageBase, a) * (1 - zoomP * 0.92);
    c.group.scale.setScalar(Math.max(0.001, s));
    c.group.rotation.y = pointer.x * 0.15 * a + Math.sin(time * 0.3 + c.dockSlot[1] * 9) * 0.12 * (1 - a);
    c.group.rotation.z = Math.sin(time * 0.4 + c.dockSlot[0] * 7) * 0.05 * (1 - a);

    const alpha = c.vis * (0.55 + 0.45 * a);
    const grey = 1 - a;
    c.glows.forEach((m) => { m.uniforms.uGrey.value = grey; m.uniforms.uOpacity.value = alpha * m.userData.gate; });
    c.lines.forEach((m) => { m.color.copy(m.userData.col).lerp(C.grey, grey); m.opacity = m.userData.base * alpha * m.userData.gate; });
    c.meshes.forEach((m) => { m.color.setRGB(1, 1, 1).lerp(C.grey, grey * 0.8); m.opacity = m.userData.base * alpha * (0.6 + 0.4 * a); });
    c.labels.forEach((m) => { m.color.setRGB(1, 1, 1).lerp(C.grey, grey); m.opacity = m.userData.base * alpha * m.userData.gate; });
  });

  scene.updateMatrixWorld();
  animateDocs(dt);
  animateDb(dt);
  animateLlm(dt);
  animateMcp(dt);
  animateAgents(dt);
  animateJudge(dt);
  animateEffects(dt);

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

/* ---- Documents: fly in, split into chunks, drop toward the DB ---- */
function animateDocs() {
  const c = comps.docs, live = FX.ingest * c.a;
  const dbTopW = tmp2.set(0, DB_TOP_LOCAL, 0).applyMatrix4(dbTilt.matrixWorld);
  const dropLocal = c.group.worldToLocal(dbTopW.clone());
  strips.forEach((sp) => {
    const homeX = (sp.d - (DOCS - 1) / 2) * (SW + 0.25), homeY = -sp.s * (SH + GAP) + 0.6;
    let x = homeX, y = homeY, z = 0, rz = 0, sx = 1, sy = 1;
    if (live > 0.05) {
      const t = ((time / 5.5) + sp.d * 0.08) % 1;
      if (t < 0.2) { const q = ease(t / 0.2); x += (1 - q) * 2.5; y += (1 - q) * 3; z = (1 - q) * -2; rz = (1 - q) * 0.6; }
      else if (t < 0.32) { /* hold as a page */ }
      else if (t < 0.52) { const q = ease((t - 0.32) / 0.2); x += sp.jx * 0.3 * q; y += (sp.s - 2.5) * 0.2 * q; z += sp.jz * 0.5 * q; rz = sp.jr * q; sx = 1 - 0.25 * q; }
      else if (t < 0.84) {
        const q = ease((t - 0.52) / 0.32);
        const fx = homeX + sp.jx * 0.3, fy = homeY + (sp.s - 2.5) * 0.2, fz = sp.jz * 0.5;
        x = lerp(fx, dropLocal.x + sp.jx * 0.6, q); y = lerp(fy, dropLocal.y, q); z = lerp(fz, dropLocal.z + sp.jz * 0.6, q);
        rz = sp.jr * (1 - q); sx = sy = (1 - q) * 0.75 + 0.02;
      } else { sx = sy = 0.0001; }
    }
    sp.mesh.position.set(x, y, z); sp.mesh.rotation.set(0, 0, rz); sp.mesh.scale.set(sx, sy, 1);
  });
}

/* ---- Vector DB: chunks sort into colour layers ---- */
function animateDb(dt) {
  dbSpin.rotation.y += dt * 0.15;
  const dp = dbGeo.attributes.position;
  for (let i = 0; i < DBN; i++) {
    const s = ease(FX.sort * 1.6 - dbDelay[i] * 0.6);
    dp.setXYZ(i, lerp(dbScatter[i * 3], dbSorted[i * 3], s), lerp(dbScatter[i * 3 + 1], dbSorted[i * 3 + 1], s), lerp(dbScatter[i * 3 + 2], dbSorted[i * 3 + 2], s));
  }
  dp.needsUpdate = true;
}

/* ---- LLM: spins faster and pulses while thinking ---- */
function animateLlm(dt) {
  const th = FX.think * comps.llm.a;
  shell.rotation.y += dt * (0.2 + th * 1.2); shell.rotation.x += dt * (0.1 + th * 0.5);
  inner.rotation.y -= dt * (0.3 + th * 2);
  inner.scale.setScalar(1 + th * 0.08 * Math.sin(time * 5));
  innerMat.uniforms.uSize.value = 9 * (1 + th * 0.35 * (0.5 + 0.5 * Math.sin(time * 8)));
  llmRings.forEach((r) => { r.ring.rotation.z += dt * r.speed * (0.4 + th * 3); });
  comps.llm.group.getWorldPosition(llmW);
}

/* ---- MCP: command LLM -> hub -> tool, tool works, result back ---- */
const CYCLE = 3.2;
function mcpPhase() {
  const t = (time / CYCLE) % 1, tool = Math.floor(time / CYCLE) % tools.length;
  return { t, tool };
}
function animateMcp(dt) {
  hub.rotation.y += dt * 0.6;
  comps.mcp.group.getWorldPosition(hubW);
  const { t, tool } = mcpPhase();
  const working = comps.mcp.a > 0.5 && (FX.mcp > 0.3 || FX.agents > 0.3);
  tools.forEach((tl, i) => {
    tl.g.getWorldPosition(toolW[i]);
    const busy = working && i === tool && t > 0.38 && t < 0.72;
    tl.box.rotation.x += dt * (busy ? 4 : 0.4); tl.box.rotation.y += dt * (busy ? 5 : 0.5);
    tl.g.scale.setScalar(busy ? 1.18 : 1);
    const p = busy ? clamp01((t - 0.38) / 0.34) : (working && i === tool && t >= 0.72 ? 1 : 0);
    tl.progress.geometry.setDrawRange(0, Math.floor(p * 49));
  });
}

/* ---- Agents: a baton passes planner -> researcher -> executor -> reviewer ---- */
const STEP = 1.4;
function animateAgents(dt) {
  agentTilt.rotation.y += dt * 0.2;
  orch.rotation.y += dt * 1.2; orch.rotation.x += dt * 0.6;
  const ap = agentGeo.attributes.position, lp = agentLinkGeo.attributes.position, sz = agentGeo.attributes.size;
  const step = Math.floor(time / STEP) % 4, f = (time / STEP) % 1;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    ap.setXYZ(i, Math.cos(a) * AR, 0, Math.sin(a) * AR);
    lp.setXYZ(i * 2, 0, 0, 0); lp.setXYZ(i * 2 + 1, Math.cos(a) * AR, 0, Math.sin(a) * AR);
    sz.setX(i, i === step && f < 0.6 ? 3.4 : 2.4);
    agentLabels[i].sprite.position.set(Math.cos(a) * AR + 0.2, 0.55, Math.sin(a) * AR);
  }
  ap.needsUpdate = true; lp.needsUpdate = true; sz.needsUpdate = true;
  // Baton: holds at the active agent, then travels along the orbit to the next one.
  const bp = batonGeo.attributes.position;
  for (let j = 0; j < 6; j++) {
    const tt = f - j * 0.025;
    const move = ease((tt - 0.6) / 0.4);
    const a = ((step + move) / 4) * Math.PI * 2;
    bp.setXYZ(j, Math.cos(a) * AR, 0.02, Math.sin(a) * AR);
  }
  bp.needsUpdate = true;
  tmp.set(Math.cos(Math.PI) * AR, 0, Math.sin(Math.PI) * AR); // executor sits at index 2
  execW.copy(tmp).applyMatrix4(agentTilt.matrixWorld);
}

/* ---- Evaluator: cases are judged in turn; one fails, 95.6% is not 100% ---- */
function animateJudge() {
  const jc = judgeGeo.attributes.color, js = judgeGeo.attributes.size;
  const live = FX.judge > 0.3;
  const judged = live ? Math.floor((time * 5) % (CASES + 10)) : 0;
  for (let i = 0; i < CASES; i++) {
    const col = i < judged ? (i === 17 ? C.fail : C.pass) : C.idle;
    jc.setXYZ(i, col.r, col.g, col.b);
    js.setX(i, live && i === judged - 1 ? 2.6 : 1.5);
  }
  jc.needsUpdate = true; js.needsUpdate = true;
}

/* ---- World-space effects ---- */
function animateEffects(dt) {
  const storyV = (1 - zoomP);
  // RAG: beams and chunks rising from the DB into the LLM.
  const ragV = FX.retrieve * comps.db.a * comps.llm.a * storyV;
  const dp = dbGeo.attributes.position;
  dbPoints.updateMatrixWorld();
  picked.forEach((idx, i) => pickedW[i].set(dp.getX(idx), dp.getY(idx), dp.getZ(idx)).applyMatrix4(dbPoints.matrixWorld));
  const bp = beamGeo.attributes.position;
  picked.forEach((_, i) => { bp.setXYZ(i * 2, llmW.x, llmW.y, llmW.z); bp.setXYZ(i * 2 + 1, pickedW[i].x, pickedW[i].y, pickedW[i].z); });
  bp.needsUpdate = true;
  beamMat.opacity = beamMat.userData.base * ragV * (0.6 + 0.4 * Math.sin(time * 6));
  const sp = streamGeo.attributes.position, ss = streamGeo.attributes.size;
  for (let i = 0; i < SP; i++) {
    const s = Math.floor(i / PER_STREAM);
    streamT[i] = (streamT[i] + dt * 0.45) % 1;
    const t = streamT[i];
    ctrl.copy(pickedW[s]).lerp(llmW, 0.5).add(tmp.set((s - 2.5) * 0.4 * stageBase, 0, 1));
    quadBezier(pickedW[s], ctrl, llmW, t, tmp2);
    sp.setXYZ(i, tmp2.x, tmp2.y, tmp2.z);
    ss.setX(i, 1.3 * Math.sin(Math.PI * t));
  }
  sp.needsUpdate = true; ss.needsUpdate = true;
  streamMat.uniforms.uOpacity.value = ragV;

  // MCP: the command packet travels LLM -> hub -> tool and back.
  // In the agentic section the executor agent is the one sending commands.
  const mcpV = Math.max(FX.mcp * comps.llm.a, FX.agents * comps.agents.a) * comps.mcp.a * storyV;
  const from = FX.agents > FX.mcp ? execW : llmW;
  const { t, tool } = mcpPhase();
  let q;
  if (t < 0.22) q = tmp.copy(from).lerp(hubW, ease(t / 0.22));
  else if (t < 0.38) q = tmp.copy(hubW).lerp(toolW[tool], ease((t - 0.22) / 0.16));
  else if (t < 0.72) q = tmp.copy(toolW[tool]);
  else if (t < 0.86) q = tmp.copy(toolW[tool]).lerp(hubW, ease((t - 0.72) / 0.14));
  else q = tmp.copy(hubW).lerp(from, ease((t - 0.86) / 0.14));
  packetHist.unshift(packetHist.pop().copy(q));
  const pp = packetGeo.attributes.position;
  packetHist.forEach((v, i) => pp.setXYZ(i, v.x, v.y, v.z));
  pp.needsUpdate = true;
  const pc = packetGeo.attributes.color, back = t >= 0.72;
  const pcol = back ? C.pass : pal[0];
  for (let i = 0; i < TRAIL; i++) pc.setXYZ(i, pcol.r, pcol.g, pcol.b);
  pc.needsUpdate = true;
  packetMat.uniforms.uOpacity.value = mcpV * (t > 0.38 && t < 0.72 ? 0.35 : 1);
  const lk = linkGeo.attributes.position;
  lk.setXYZ(0, from.x, from.y, from.z); lk.setXYZ(1, hubW.x, hubW.y, hubW.z);
  lk.setXYZ(2, hubW.x, hubW.y, hubW.z); lk.setXYZ(3, toolW[tool].x, toolW[tool].y, toolW[tool].z);
  lk.needsUpdate = true;
  linkMat.opacity = linkMat.userData.base * mcpV;

  // Answer tokens spiral out of the LLM while it is being evaluated.
  const tokV = FX.tokens * comps.llm.a * storyV;
  const tp = tokenGeo.attributes.position, ts = tokenGeo.attributes.size;
  tokens.forEach((tk, i) => {
    tk.t = (tk.t + dt * tk.speed) % 1;
    const tt = tk.t, a = tk.lane + tt * 5, spread = stageBase;
    tp.setXYZ(i, llmW.x + Math.cos(a) * (1.2 + tt * 2.4) * spread, llmW.y + (Math.sin(a) * (1.2 + tt * 2.2) + tt * 1.5) * spread, llmW.z + Math.sin(a * 0.7) * spread);
    ts.setX(i, 1.2 * (1 - tt) * Math.min(1, tt * 8));
  });
  tp.needsUpdate = true; ts.needsUpdate = true;
  tokenMat.uniforms.uOpacity.value = tokV;
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

/* ================================================================== */
/* Helpers                                                            */
/* ================================================================== */
function vecAt(arr, i) { return new THREE.Vector3(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]); }
function quadBezier(a, c, b, t, out) {
  const u = 1 - t;
  return out.set(u * u * a.x + 2 * u * t * c.x + t * t * b.x, u * u * a.y + 2 * u * t * c.y + t * t * b.y, u * u * a.z + 2 * u * t * c.z + t * t * b.z);
}
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
})();
