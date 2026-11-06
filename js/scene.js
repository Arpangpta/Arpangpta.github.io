// Hero scene: an "embedding space" of glowing clusters joined by a sparse
// network, with signal pulses hopping node to node like activations.
// Loaded as a classic script so the page also works when opened straight from
// disk (file://), where Chrome blocks local ES modules. Three.js comes from the CDN.
(async () => {
let THREE;
try {
  THREE = await import("https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js");
} catch (err) {
  document.documentElement.classList.add("no-webgl");
  return;
}

const canvas = document.getElementById("hero-canvas");
const hero = document.getElementById("hero");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const small = window.innerWidth < 768;

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
} catch (err) {
  document.documentElement.classList.add("no-webgl");
}

if (renderer) (document.fonts ? document.fonts.ready : Promise.resolve()).then(init);

function init() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
  camera.position.set(0, 0, 19);

  // Keep the cloud to the right on wide screens so the text stays readable.
  const world = new THREE.Group();
  scene.add(world);

  const palette = [0x22d3ee, 0xa78bfa, 0xf472b6, 0x34d399, 0x60a5fa, 0xc4b5fd].map((c) => new THREE.Color(c));
  const rand = mulberry32(7);
  const gauss = () => { let u = 0, v = 0; while (!u) u = rand(); while (!v) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

  /* ---- Nodes: clusters on a sphere plus a sparse background haze ---- */
  const CLUSTERS = 7;
  const PER_CLUSTER = small ? 55 : 95;
  const HAZE = small ? 260 : 600;
  const positions = [], colors = [], sizes = [], phases = [], clusterOf = [];
  const centers = [];
  for (let c = 0; c < CLUSTERS; c++) {
    const theta = (c / CLUSTERS) * Math.PI * 2 + rand() * 0.4;
    const phi = Math.acos(2 * rand() - 1);
    centers.push(new THREE.Vector3(Math.sin(phi) * Math.cos(theta), Math.cos(phi) * 0.75, Math.sin(phi) * Math.sin(theta)).multiplyScalar(6.4));
  }
  centers.forEach((center, c) => {
    for (let i = 0; i < PER_CLUSTER; i++) {
      const spread = 0.7 + rand() * 0.25;
      positions.push(center.x + gauss() * spread, center.y + gauss() * spread, center.z + gauss() * spread);
      const col = palette[c % palette.length].clone().lerp(new THREE.Color(0xffffff), rand() * 0.25);
      colors.push(col.r, col.g, col.b);
      sizes.push(0.55 + rand() * 1.1);
      phases.push(rand() * Math.PI * 2);
      clusterOf.push(c);
    }
  });
  for (let i = 0; i < HAZE; i++) {
    const r = 6 + rand() * 9;
    const t = rand() * Math.PI * 2, p = Math.acos(2 * rand() - 1);
    positions.push(r * Math.sin(p) * Math.cos(t), r * Math.cos(p) * 0.7, r * Math.sin(p) * Math.sin(t));
    const col = new THREE.Color(0x8b93a7);
    colors.push(col.r, col.g, col.b);
    sizes.push(0.25 + rand() * 0.45);
    phases.push(rand() * Math.PI * 2);
    clusterOf.push(-1);
  }

  const nodeGeo = new THREE.BufferGeometry();
  nodeGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  nodeGeo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  nodeGeo.setAttribute("size", new THREE.Float32BufferAttribute(sizes, 1));
  nodeGeo.setAttribute("phase", new THREE.Float32BufferAttribute(phases, 1));

  const uniforms = {
    uTime: { value: 0 },
    uPixelRatio: { value: renderer.getPixelRatio() },
    uOpacity: { value: 1 },
  };
  const glowMaterial = (baseSize, twinkle) => new THREE.ShaderMaterial({
    uniforms,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute float size; attribute float phase;
      uniform float uTime; uniform float uPixelRatio;
      varying vec3 vColor; varying float vTw;
      void main() {
        vColor = color;
        vTw = ${twinkle ? "0.65 + 0.35 * sin(uTime * 1.6 + phase)" : "1.0"};
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = ${baseSize.toFixed(1)} * size * uPixelRatio * (12.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float uOpacity;
      varying vec3 vColor; varying float vTw;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float core = smoothstep(0.5, 0.0, d);
        float glow = pow(core, 2.2);
        gl_FragColor = vec4(vColor * (0.6 + glow), glow * vTw * uOpacity);
      }`,
  });
  world.add(new THREE.Points(nodeGeo, glowMaterial(12.0, true)));

  /* ---- Edges: each clustered node links to its nearest neighbours ---- */
  const nodeCount = CLUSTERS * PER_CLUSTER;
  const P = (i) => new THREE.Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  const edges = [];
  const adjacency = Array.from({ length: nodeCount }, () => []);
  const addEdge = (a, b) => {
    if (adjacency[a].some((e) => edges[e][0] === b || edges[e][1] === b)) return;
    edges.push([a, b]);
    adjacency[a].push(edges.length - 1);
    adjacency[b].push(edges.length - 1);
  };
  for (let c = 0; c < CLUSTERS; c++) {
    const start = c * PER_CLUSTER;
    for (let i = start; i < start + PER_CLUSTER; i++) {
      const pi = P(i);
      const near = [];
      for (let j = start; j < start + PER_CLUSTER; j++) if (j !== i) near.push([pi.distanceToSquared(P(j)), j]);
      near.sort((a, b) => a[0] - b[0]);
      near.slice(0, 2).forEach(([, j]) => addEdge(i, j));
    }
  }
  // Long-range "semantic" links between clusters.
  for (let c = 0; c < CLUSTERS; c++) {
    for (let k = 0; k < 1; k++) {
      const other = (c + 1 + Math.floor(rand() * (CLUSTERS - 1))) % CLUSTERS;
      addEdge(c * PER_CLUSTER + Math.floor(rand() * PER_CLUSTER), other * PER_CLUSTER + Math.floor(rand() * PER_CLUSTER));
    }
  }
  const linePos = [], lineCol = [];
  edges.forEach(([a, b]) => {
    linePos.push(...P(a).toArray(), ...P(b).toArray());
    lineCol.push(colors[a * 3], colors[a * 3 + 1], colors[a * 3 + 2], colors[b * 3], colors[b * 3 + 1], colors[b * 3 + 2]);
  });
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute("position", new THREE.Float32BufferAttribute(linePos, 3));
  lineGeo.setAttribute("color", new THREE.Float32BufferAttribute(lineCol, 3));
  const lineMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false });
  world.add(new THREE.LineSegments(lineGeo, lineMat));

  /* ---- Concept labels floating next to each cluster ---- */
  const LABELS = ["retrieval", "agents", "evals", "routing", "tools", "guardrails", "embeddings"];
  const labelMat = [];
  centers.forEach((center, c) => {
    const cv = document.createElement("canvas");
    cv.width = 512; cv.height = 96;
    const ctx = cv.getContext("2d");
    ctx.font = "500 44px 'JetBrains Mono', monospace";
    ctx.fillStyle = "#" + palette[c % palette.length].getHexString();
    ctx.fillText("// " + LABELS[c % LABELS.length], 8, 62);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.55, depthWrite: false });
    labelMat.push(mat);
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(2.8, 0.525, 1);
    sprite.position.copy(center).add(new THREE.Vector3(1.6, 1.5, 0));
    world.add(sprite);
  });

  /* ---- Pulses: signals that travel an edge, then hop to a connected one ---- */
  const PULSES = small ? 40 : 90;
  const pulses = [];
  const pulsePos = new Float32Array(PULSES * 3);
  const pulseCol = new Float32Array(PULSES * 3);
  const pulseSize = new Float32Array(PULSES).fill(1.6);
  const pulsePhase = new Float32Array(PULSES);
  for (let i = 0; i < PULSES; i++) {
    const e = Math.floor(rand() * edges.length);
    pulses.push({ edge: e, from: edges[e][0], t: rand(), speed: 0.35 + rand() * 0.6 });
  }
  const pulseGeo = new THREE.BufferGeometry();
  pulseGeo.setAttribute("position", new THREE.BufferAttribute(pulsePos, 3));
  pulseGeo.setAttribute("color", new THREE.BufferAttribute(pulseCol, 3));
  pulseGeo.setAttribute("size", new THREE.BufferAttribute(pulseSize, 1));
  pulseGeo.setAttribute("phase", new THREE.BufferAttribute(pulsePhase, 1));
  world.add(new THREE.Points(pulseGeo, glowMaterial(13.0, false)));

  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
  function updatePulses(dt) {
    pulses.forEach((p, i) => {
      p.t += dt * p.speed;
      if (p.t >= 1) {
        // Arrived: continue from the far node along another edge.
        const [a, b] = edges[p.edge];
        const node = p.from === a ? b : a;
        const options = adjacency[node].filter((e) => e !== p.edge);
        p.edge = options.length ? options[Math.floor(Math.random() * options.length)] : Math.floor(Math.random() * edges.length);
        p.from = options.length ? node : edges[p.edge][0];
        p.t = 0;
      }
      const [a, b] = edges[p.edge];
      const to = p.from === a ? b : a;
      tmpA.set(positions[p.from * 3], positions[p.from * 3 + 1], positions[p.from * 3 + 2]);
      tmpB.set(positions[to * 3], positions[to * 3 + 1], positions[to * 3 + 2]);
      tmpA.lerp(tmpB, p.t);
      pulsePos.set([tmpA.x, tmpA.y, tmpA.z], i * 3);
      const c = palette[clusterOf[to] % palette.length];
      pulseCol.set([0.6 + c.r * 0.6, 0.6 + c.g * 0.6, 0.6 + c.b * 0.6], i * 3);
    });
    pulseGeo.attributes.position.needsUpdate = true;
    pulseGeo.attributes.color.needsUpdate = true;
  }

  /* ---- Interaction ---- */
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  window.addEventListener("pointermove", (e) => {
    pointer.tx = (e.clientX / window.innerWidth - 0.5) * 2;
    pointer.ty = (e.clientY / window.innerHeight - 0.5) * 2;
  }, { passive: true });

  function resize() {
    const w = hero.clientWidth, h = hero.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // Desktop: sit to the right of the headline. Mobile: smaller, lower, behind the buttons.
    const desktop = w > 900;
    world.position.set(desktop ? 4.2 : 0, desktop ? 0 : -6.5, 0);
    world.scale.setScalar(desktop ? 1 : 0.62);
  }
  window.addEventListener("resize", resize);
  resize();

  /* ---- Loop: only runs while the hero is visible and the tab is active ---- */
  let visible = true, running = false, last = performance.now();
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; start(); }).observe(hero);
  document.addEventListener("visibilitychange", start);

  const clock = { t: 0 };
  function frame(now) {
    if (!visible || document.hidden) { running = false; return; }
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    clock.t += dt;
    uniforms.uTime.value = clock.t;

    pointer.x += (pointer.tx - pointer.x) * 0.04;
    pointer.y += (pointer.ty - pointer.y) * 0.04;
    world.rotation.y = clock.t * 0.06 + pointer.x * 0.35;
    world.rotation.x = pointer.y * 0.18;

    // Scroll: pull the camera back and fade as the hero leaves.
    const sp = Math.min(window.scrollY / window.innerHeight, 1);
    camera.position.z = 19 + sp * 7;
    uniforms.uOpacity.value = 1 - sp * 0.85;
    lineMat.opacity = 0.22 * (1 - sp * 0.85);
    labelMat.forEach((m) => { m.opacity = 0.55 * (1 - sp); });

    updatePulses(dt);
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  function start() {
    if (reduceMotion || running || !visible || document.hidden) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(frame);
  }

  if (reduceMotion) {
    updatePulses(0);
    world.rotation.y = 0.6;
    renderer.render(scene, camera);
  } else {
    start();
  }
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
