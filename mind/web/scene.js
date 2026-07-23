// three.js scene setup + render loop. Does not handle data fetching/DOM panel logic (separation of concerns: app.js/interactions.js/ask.js handle that).
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from './vendor/CSS2DRenderer.js';
import { sourceColor, clusterHue, hexToCss, makeGlowCanvas, arcMidpoint, clamp, seededRandom } from './utils.js';

function animateValue(from, to, duration, onUpdate, onDone) {
  const start = performance.now();
  function step(now) {
    const t = clamp((now - start) / duration, 0, 1);
    onUpdate(from + (to - from) * t, t);
    if (t < 1) requestAnimationFrame(step);
    else if (onDone) onDone();
  }
  requestAnimationFrame(step);
}

// Invisible hit proxy for cluster picking/label anchor. Since the nebula particles themselves
// don't receive raycasts, this stabilizes the click hit area to a single sphere (inherits the raycastTargets/label anchor role the old core mesh used to handle).
function buildClusterHitProxy(c) {
  const geom = new THREE.SphereGeometry(Math.max(c.radius * 0.85, 3), 12, 8);
  const mat = new THREE.MeshBasicMaterial({ visible: false });
  const mesh = new THREE.Mesh(geom, mat);
  return mesh;
}

// Nebula particle shader: instead of a circular sprite, procedurally draws an angle-dependent
// wobbly blob edge (no texture) so individual particles read as a gas cloud with an indistinct boundary.
const NEBULA_VERTEX_SHADER = `
  attribute float aSize;
  attribute float aAlpha;
  attribute float aSeed;
  attribute vec3 aOrbitAxis;
  attribute float aOrbitSpeed;
  attribute float aIsCore;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSeed;
  uniform float uDim;
  uniform float uBreath;
  uniform float uTime;
  // Select pulse: multiplied only into the core particles (aIsCore=1) of the cluster selected
  // by click; for other particles/unselected state, mix() returns 1.0 for zero effect (a separate
  // multiplier independent of uBoost/uDim/uBreath, so it doesn't interfere with existing flashCluster/setClusterDim).
  uniform float uSelectPulse;
  void main() {
    vColor = color;
    vAlpha = aAlpha * uDim * uBreath * mix(1.0, uSelectPulse, aIsCore);
    vSeed = aSeed;

    // Per-particle individual orbit: rotates over time around a seed-derived axis (aOrbitAxis)
    // so each particle orbits the nebula center (local origin) with its own orbital plane and
    // speed — since the Rodrigues rotation formula preserves radius identically, the existing
    // position's distance from center becomes the orbit radius directly, with no separate radius
    // value needed. The CPU only uploads a single uTime scalar per frame; all actual position
    // computation happens in the GPU vertex stage.
    vec3 axis = normalize(aOrbitAxis);
    float ang = uTime * aOrbitSpeed + aSeed * 6.2831853;
    float co = cos(ang);
    float si = sin(ang);
    vec3 p = position;
    vec3 orbited = p * co + cross(axis, p) * si + axis * dot(axis, p) * (1.0 - co);

    vec4 mvPosition = modelViewMatrix * vec4(orbited, 1.0);
    gl_PointSize = aSize * (340.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;
const NEBULA_FRAGMENT_SHADER = `
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSeed;
  uniform float uBoost;
  // Lock dim-out desaturation: 1=original color, 0=achromatic (luminance only). setClusterLight animates this.
  uniform float uSaturation;
  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv);
    float ang = atan(uv.y, uv.x) + vSeed * 6.2831853;
    float lump = 1.0 + 0.18 * sin(ang * 3.0 + vSeed * 11.0) + 0.10 * sin(ang * 7.0 - vSeed * 5.0);
    float edge = 0.5 * lump;
    if (d > edge) discard;
    float falloff = smoothstep(edge, edge * 0.1, d);
    float alpha = falloff * vAlpha;
    if (alpha <= 0.0) discard;
    vec3 col = vColor * uBoost;
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(lum), col, uSaturation);
    gl_FragColor = vec4(col, alpha);
  }
`;

// Turns a single cluster into a voluminous nebula particle cloud. Draws a small bright core and
// a body (density biased toward the center within the radius, sparser and dimmer toward the edge)
// in one Points draw call to save a draw call per cluster.
// Placement is deterministically fixed with a hash-seeded PRNG (no Math.random — same shape across reload/rerun).
function buildNebulaCloud(c, hue, seedKey) {
  const rand = seededRandom(seedKey);
  const radius = Math.max(c.radius, 3);
  const count = Math.round(clamp(18 + radius * 1.8, 26, 46));
  const coreCount = Math.max(4, Math.round(count * 0.22));

  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const alphas = new Float32Array(count);
  const seeds = new Float32Array(count);
  const orbitAxes = new Float32Array(count * 3);
  const orbitSpeeds = new Float32Array(count);
  const isCores = new Float32Array(count);

  const baseColor = new THREE.Color(hue);
  const coreColor = baseColor.clone().lerp(new THREE.Color(0xffffff), 0.4);
  const tmp = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const isCore = i < coreCount;
    isCores[i] = isCore ? 1 : 0;
    const theta = rand() * Math.PI * 2;
    const phi = Math.acos(2 * rand() - 1);
    const spread = isCore ? 0.32 : 1.0;
    const rr = radius * spread * Math.pow(rand(), 1.5); // Density biased toward center (volume fill, not a surface shell)
    const stretch = 0.85 + rand() * 0.3;
    positions[i * 3 + 0] = rr * Math.sin(phi) * Math.cos(theta) * stretch;
    positions[i * 3 + 1] = rr * Math.cos(phi) * stretch;
    positions[i * 3 + 2] = rr * Math.sin(phi) * Math.sin(theta) * stretch;

    const edgeFactor = clamp(rr / radius, 0, 1);
    sizes[i] = isCore
      ? radius * (0.55 + rand() * 0.3)
      : radius * (0.5 + rand() * 0.85) * (1 - edgeFactor * 0.3);
    alphas[i] = isCore
      ? 0.7 + rand() * 0.25
      : clamp(0.5 - edgeFactor * 0.35 + rand() * 0.15, 0.05, 0.55);
    seeds[i] = rand();

    // Orbit axis/speed are also deterministically derived from the same seed stream (no Math.random).
    // The axis is sampled uniformly on the sphere independent of the position vector, so each
    // particle gets a different orbital plane — no separate radius is kept, since the Rodrigues
    // rotation preserves |position| as-is, so the already-computed center distance (rr) becomes the orbit radius.
    const axTheta = rand() * Math.PI * 2;
    const axPhi = Math.acos(2 * rand() - 1);
    orbitAxes[i * 3 + 0] = Math.sin(axPhi) * Math.cos(axTheta);
    orbitAxes[i * 3 + 1] = Math.cos(axPhi);
    orbitAxes[i * 3 + 2] = Math.sin(axPhi) * Math.sin(axTheta);
    const orbitDir = rand() < 0.5 ? -1 : 1;
    orbitSpeeds[i] = orbitDir * (0.025 + rand() * 0.09); // rad/s → roughly 40s~250s per revolution (slow)

    tmp.copy(baseColor).lerp(coreColor, isCore ? 0.55 + rand() * 0.35 : rand() * 0.25);
    colors[i * 3 + 0] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geom.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geom.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
  geom.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geom.setAttribute('aOrbitAxis', new THREE.BufferAttribute(orbitAxes, 3));
  geom.setAttribute('aOrbitSpeed', new THREE.BufferAttribute(orbitSpeeds, 1));
  geom.setAttribute('aIsCore', new THREE.BufferAttribute(isCores, 1));
  geom.computeBoundingSphere();

  const material = new THREE.ShaderMaterial({
    uniforms: { uDim: { value: 1 }, uBoost: { value: 1 }, uBreath: { value: 1 }, uTime: { value: 0 }, uSelectPulse: { value: 1 }, uSaturation: { value: 1 } },
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: NEBULA_VERTEX_SHADER,
    fragmentShader: NEBULA_FRAGMENT_SHADER,
  });

  const points = new THREE.Points(geom, material);
  points.raycast = () => {};
  points.userData.baseDim = 1;
  points.userData.baseBoost = 1;
  return points;
}

function buildGlowSprite(hue, worldSize, opacity) {
  const canvas = makeGlowCanvas(hue);
  const tex = new THREE.CanvasTexture(canvas);
  if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(worldSize, worldSize, 1);
  sprite.userData.baseOpacity = opacity;
  sprite.raycast = () => {};
  return sprite;
}

// M9: Personal cluster ring — a dashed ring in orbit outside the nebula marks it as a personal-owned space.
function buildPersonalRing(radius, hue) {
  const r = radius * 1.9;
  const pts = new THREE.EllipseCurve(0, 0, r, r).getPoints(96);
  const geom = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineDashedMaterial({ color: hue, dashSize: 2.4, gapSize: 1.8, transparent: true, opacity: 0.55, depthWrite: false });
  const ring = new THREE.LineLoop(geom, mat);
  ring.computeLineDistances();
  ring.rotation.x = -Math.PI / 2;
  ring.raycast = () => {};
  return ring;
}

function createStarField(count = 4000) {
  const positions = new Float32Array(count * 3);
  const phases = new Float32Array(count);
  const sizes = new Float32Array(count);
  const colors = new Float32Array(count * 3);
  const color = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = 320 + Math.random() * 680;
    positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    phases[i] = Math.random() * Math.PI * 2;
    sizes[i] = 0.6 + Math.random() * 1.8;
    const warm = Math.random() < 0.12;
    color.setHSL(warm ? 0.09 : 0.6, warm ? 0.35 : 0.15, warm ? 0.75 : 0.85);
    colors[i * 3 + 0] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geom.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute float aPhase;
      attribute float aSize;
      varying vec3 vColor;
      varying float vTwinkle;
      uniform float uTime;
      void main() {
        vColor = color;
        vTwinkle = 0.55 + 0.45 * sin(uTime * 1.4 + aPhase);
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * vTwinkle * (300.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vTwinkle;
      void main() {
        vec2 uv = gl_PointCoord - vec2(0.5);
        float d = length(uv);
        if (d > 0.5) discard;
        float alpha = smoothstep(0.5, 0.0, d) * vTwinkle;
        gl_FragColor = vec4(vColor, alpha);
      }
    `,
  });
  const points = new THREE.Points(geom, material);
  points.raycast = () => {};
  return { points, material };
}

export function createUniverseScene({ mountEl, labelMountEl, data }) {
  const { clusters, docs, edges } = data;
  const initialCameraPos = new THREE.Vector3(150, 95, 220);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x05060a, 0.0016);

  const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 4000);
  camera.position.copy(initialCameraPos);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x05060a, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
  mountEl.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.domElement.style.pointerEvents = 'none';
  labelMountEl.appendChild(labelRenderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 20;
  controls.maxDistance = 620;
  controls.target.set(0, 0, 0);

  scene.add(new THREE.HemisphereLight(0x4a5578, 0x05060a, 0.65));
  const sun = new THREE.DirectionalLight(0xffffff, 0.55);
  sun.position.set(80, 140, 60);
  scene.add(sun);

  const starField = createStarField();
  scene.add(starField.points);

  // Observatory core beacon — symbolizes the origin point from which queries are launched. Subtle when idle, bright while a query is in flight.
  const beaconGroup = new THREE.Group();
  const beaconCore = new THREE.Mesh(
    new THREE.IcosahedronGeometry(2.2, 1),
    new THREE.MeshBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.35 })
  );
  beaconCore.raycast = () => {};
  const beaconGlow = buildGlowSprite(0xfbbf24, 14, 0.22);
  beaconGroup.add(beaconCore, beaconGlow);
  scene.add(beaconGroup);

  const clusterGroup = new THREE.Group();
  const edgeGroup = new THREE.Group();
  scene.add(clusterGroup, edgeGroup);

  const clusterEntries = [];
  const clusterBySlug = new Map();
  clusters.forEach((c, i) => {
    const hue = clusterHue(i);
    const core = buildClusterHitProxy(c);
    const nebula = buildNebulaCloud(c, hue, `${c.slug}:nebula`);
    const glowNear = buildGlowSprite(hue, c.radius * 2.4, 0.4);
    const glowFar = buildGlowSprite(hue, c.radius * 4.2, 0.18);
    core.position.set(c.pos[0], c.pos[1], c.pos[2]);
    nebula.position.copy(core.position);
    glowNear.position.copy(core.position);
    glowFar.position.copy(core.position);
    core.userData.kind = 'cluster';
    core.userData.data = c;
    core.userData.color = hue;

    const labelDiv = document.createElement('div');
    labelDiv.className = c.owner ? 'cluster-label cluster-label-personal' : 'cluster-label';
    labelDiv.style.setProperty('--cluster-color', hexToCss(hue));
    labelDiv.textContent = c.owner ? `개인 · ${c.name}` : c.name;
    const label = new CSS2DObject(labelDiv);
    label.position.set(0, c.radius + 4, 0);
    core.add(label);

    let personalRing = null;
    if (c.owner) {
      personalRing = buildPersonalRing(c.radius, hue);
      personalRing.position.copy(core.position);
      clusterGroup.add(personalRing);
    }

    // Subtle individual rotation/pulse period — deterministically drawn differently per cluster so they don't appear synchronized.
    const motionRand = seededRandom(`${c.slug}:motion`);
    const rotSpeed = (motionRand() < 0.5 ? -1 : 1) * (0.015 + motionRand() * 0.035); // rad/s, one revolution per 2~7 min
    const breathSpeed = 0.7 + motionRand() * 0.9; // rad/s, roughly a 4~9s period
    const breathPhase = motionRand() * Math.PI * 2;

    clusterGroup.add(core, nebula, glowNear, glowFar);

    const entry = {
      slug: c.slug, data: c, core, nebula, glowNear, glowFar, label, color: hue, personalRing,
      dimTweenId: 0, rotSpeed, breathSpeed, breathPhase,
      // Per-cluster motion lock: rotation, pulse, particle orbit, and member-document orbit all
      // share this clock. Locking stops the clock; unlocking resumes from where it stopped, with no jump.
      motionEnabled: true, motionTime: 0,
      // Dim-out on lock: if true, the nebula/glow/ring/label/member documents dim to an afterglow level.
      lightsOut: false,
    };
    clusterEntries.push(entry);
    clusterBySlug.set(c.slug, entry);
  });

  edges.forEach((e) => {
    const a = clusterBySlug.get(e.a);
    const b = clusterBySlug.get(e.b);
    if (!a || !b) return;
    const mid = arcMidpoint(a.data.pos, b.data.pos, 0.16);
    const curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(...a.data.pos),
      new THREE.Vector3(...mid),
      new THREE.Vector3(...b.data.pos)
    );
    const points = curve.getPoints(28);
    const geom = new THREE.BufferGeometry().setFromPoints(points);
    const weight = clamp(e.weight ?? 0.3, 0, 1);
    const mat = new THREE.LineBasicMaterial({ color: 0x8fa5d6, transparent: true, opacity: clamp(0.08 + weight * 0.22, 0.08, 0.32) });
    const line = new THREE.Line(geom, mat);
    line.raycast = () => {};
    edgeGroup.add(line);
  });

  // Document particles — point lights (Points) that look like stars. Used to be InstancedMesh
  // spheres, but those read as 3D solids (volume becomes noticeable when rotating), so they're
  // replaced with single-point starlight. Unlike the nebula (buildNebulaCloud), this doesn't add
  // angular blob wobble — it just uses a solid circular core + a very short edge fade so it reads
  // as individual points rather than a "clump". Click/hover hit-testing is handled entirely by a
  // separate invisible InstancedMesh proxy (Points' raycast threshold is in world units rather
  // than screen-projected size, which makes hit-testing unstable across zoom levels, so this
  // reuses the same proven pattern as the cluster hit proxy). This proxy never uses vertexColors,
  // so it's unaffected by the InstancedMesh+vertexColors black-rendering pitfall.
  // aDocIndex: carries a unique integer (0..N-1) per document, compared (via step) against the
  // selected document index inside the shader to pick out exactly one point for the pulse.
  // Position is never altered here (only size/brightness change), so it can never drift from
  // docHitProxy's static instance matrix.
  const DOC_POINT_VERTEX_SHADER = `
    attribute float aSize;
    attribute float aDocIndex;
    varying vec3 vColor;
    varying float vGlow;
    varying float vTwinkle;
    uniform float uHighlightIndex;
    uniform float uHighlightFade;
    uniform float uTime;
    void main() {
      vColor = color;
      float isHi = step(abs(aDocIndex - uHighlightIndex), 0.5);
      // A 2-second-period (angular velocity = 2π/2s = π rad/s) sine pulse, smoothly bouncing
      // between 0..1 — brightens and dims gradually with no abrupt on/off. For unselected points
      // isHi=0, so vGlow is always 0 too, with zero effect on rendering. uHighlightFade is a
      // separate multiplier (tweened on the CPU) that smoothly wraps the select/deselect transition
      // itself — independent of the pulse, it only removes the abruptness of the on/off transition.
      float pulse = 0.5 + 0.5 * sin(uTime * 3.14159265);
      vGlow = isHi * pulse * uHighlightFade;

      // Subtle twinkle: hashes aDocIndex/aSize to draw a different phase (and slightly different
      // frequency) per particle — a deterministic seed recomputed each frame as a pure function on
      // the GPU, no Math.random. Amplitude is kept to ±15% (0.85~1.15) to express only a "subtle" flicker.
      float seed = fract(sin(aDocIndex * 12.9898 + aSize * 78.233) * 43758.5453);
      vTwinkle = 1.0 + 0.15 * sin(uTime * (1.6 + seed * 0.8) + seed * 6.2831853);

      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      // Scale the core size up by 1.8x to leave room for the cross diffraction spikes to extend
      // into — docHitProxy (click hit-testing) uses a separate InstancedMesh scale (dummy.scale,
      // based on docScales on the JS side), so it's entirely unaffected by this value; the click hit-test size stays unchanged.
      gl_PointSize = aSize * 1.8 * (1.0 + vGlow * 0.9) * (260.0 / -mvPosition.z);
      gl_Position = projectionMatrix * mvPosition;
    }
  `;
  const DOC_POINT_FRAGMENT_SHADER = `
    varying vec3 vColor;
    varying float vGlow;
    varying float vTwinkle;
    void main() {
      vec2 uv = gl_PointCoord - vec2(0.5);
      float d = length(uv);
      if (d > 0.5) discard;

      // Core: a high-luminance spot with the small central area pulled toward white (mimics the hot center of a real star).
      float core = smoothstep(0.16, 0.0, d);
      vec3 coreColor = mix(vColor, vec3(1.0), 0.82);

      // halo: an exponentially decaying glow carrying the raw source_type color — it spreads out
      // from the core and fades. The legend contrast (session=teal/arxiv=purple/rss=orange/
      // manual=off-white) is handled entirely by this halo (the core is near-white so it isn't used for color distinction).
      float halo = exp(-d * 6.5);

      // Cross diffraction spikes: thin light rays extending along two axes. pow() narrows them
      // sharply off-axis, and exp() fades them the further along the axis they extend — procedural
      // spikes mimicking the diffraction artifacts seen in star photos (no texture, kept subtle
      // with a 0.5 multiplier). During the select pulse (vGlow), the axis-direction falloff is
      // relaxed slightly so the spikes extend a bit further as part of the effect.
      float armFade = 4.5 - vGlow * 1.8;
      float armV = pow(clamp(1.0 - abs(uv.x) * 22.0, 0.0, 1.0), 1.8) * exp(-abs(uv.y) * armFade);
      float armH = pow(clamp(1.0 - abs(uv.y) * 22.0, 0.0, 1.0), 1.8) * exp(-abs(uv.x) * armFade);
      float spikes = (armV + armH) * 0.5;

      vec3 starColor = mix(vColor * halo, coreColor, core);
      starColor += (vColor * 0.6 + vec3(0.4)) * spikes;
      // The select pulse also pulls the color further toward white, giving a clearly brighter impression (existing behavior preserved).
      starColor = mix(starColor, vec3(1.0), vGlow * 0.6);

      // The "default 0.55 translucent / max 1.0 when selected" alpha rule finalized in R5~R6 is
      // kept as-is, except that alpha now applies to the entire "star shape" silhouette (core+halo+spikes).
      // Multiplied by vTwinkle (±15%) to add a subtle brightness flicker.
      float shapeAlpha = clamp(max(core, halo) + spikes, 0.0, 1.0);
      float alpha = shapeAlpha * mix(0.55, 1.0, vGlow) * vTwinkle;
      if (alpha <= 0.0) discard;
      gl_FragColor = vec4(starColor, clamp(alpha, 0.0, 1.0));
    }
  `;

  const docPositions = new Float32Array(docs.length * 3);
  const docColors = new Float32Array(docs.length * 3);
  const docSizes = new Float32Array(docs.length);
  const docScales = new Float32Array(docs.length);
  const docIndices = new Float32Array(docs.length);
  // Document point orbit parameters (CPU-computed, single source of truth). The radius (XZ) and
  // y-offset relative to the cluster center are fixed-derived from the original d.pos to preserve
  // the "lower fit = outer orbit" meaning, and only the angle rotates over time. Unlike the nebula
  // (vertex-shader orbit), docHitProxy/getDocWorldPos need to be able to reference this, so it's
  // updated on the CPU every frame, and that value is fed identically into both the position buffer and the hit proxy matrix.
  const docCenterX = new Float32Array(docs.length);
  const docCenterY = new Float32Array(docs.length);
  const docCenterZ = new Float32Array(docs.length);
  const docRadiusXZ = new Float32Array(docs.length);
  const docOffsetY = new Float32Array(docs.length);
  const docBaseAngle = new Float32Array(docs.length);
  const docOrbitSpeed = new Float32Array(docs.length);
  const docCurrentPos = new Array(docs.length);
  const docClusterEntry = new Array(docs.length);
  const tmpColor = new THREE.Color();
  docs.forEach((d, i) => {
    const fit = d.fit ?? 0.55;
    const scale = 0.7 + fit * 0.6;
    docScales[i] = scale;
    docPositions[i * 3 + 0] = d.pos[0];
    docPositions[i * 3 + 1] = d.pos[1];
    docPositions[i * 3 + 2] = d.pos[2];
    docSizes[i] = 2.0 + fit * 2.4;
    docIndices[i] = i;
    tmpColor.set(sourceColor(d.source_type));
    docColors[i * 3 + 0] = tmpColor.r;
    docColors[i * 3 + 1] = tmpColor.g;
    docColors[i * 3 + 2] = tmpColor.b;

    const clusterEntry = clusterBySlug.get(d.cluster_slug);
    docClusterEntry[i] = clusterEntry ?? null; // Reference to the motion-lock clock (unaffiliated documents use the global clock)
    const center = clusterEntry ? clusterEntry.core.position : new THREE.Vector3(d.pos[0], d.pos[1], d.pos[2]);
    const dx = d.pos[0] - center.x;
    const dy = d.pos[1] - center.y;
    const dz = d.pos[2] - center.z;
    docCenterX[i] = center.x;
    docCenterY[i] = center.y;
    docCenterZ[i] = center.z;
    docRadiusXZ[i] = Math.hypot(dx, dz);
    docOffsetY[i] = dy;
    docBaseAngle[i] = Math.atan2(dz, dx);
    const orbitRand = seededRandom(`${d.doc_id}:orbit`);
    const orbitDir = orbitRand() < 0.5 ? -1 : 1;
    // rad/s — roughly 2~5 min per revolution (slower than the nebula's 40~250s, so documents read calmly).
    docOrbitSpeed[i] = orbitDir * (0.021 + orbitRand() * 0.031);
    docCurrentPos[i] = new THREE.Vector3(d.pos[0], d.pos[1], d.pos[2]);
  });

  // Original colors for restoring after dim-out, plus per-cluster document index (when locked, the doc points darken too).
  const docBaseColors = docColors.slice();
  const docIndicesBySlug = new Map();
  docs.forEach((d, i) => {
    if (!d.cluster_slug) return;
    if (!docIndicesBySlug.has(d.cluster_slug)) docIndicesBySlug.set(d.cluster_slug, []);
    docIndicesBySlug.get(d.cluster_slug).push(i);
  });

  const docGeom = new THREE.BufferGeometry();
  docGeom.setAttribute('position', new THREE.BufferAttribute(docPositions, 3));
  docGeom.setAttribute('color', new THREE.BufferAttribute(docColors, 3));
  docGeom.setAttribute('aSize', new THREE.BufferAttribute(docSizes, 1));
  docGeom.setAttribute('aDocIndex', new THREE.BufferAttribute(docIndices, 1));
  docGeom.computeBoundingSphere();

  const docMat = new THREE.ShaderMaterial({
    uniforms: { uHighlightIndex: { value: -1 }, uHighlightFade: { value: 0 }, uTime: { value: 0 } },
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    vertexShader: DOC_POINT_VERTEX_SHADER,
    fragmentShader: DOC_POINT_FRAGMENT_SHADER,
  });
  const docPoints = new THREE.Points(docGeom, docMat);
  docPoints.raycast = () => {}; // Picking is handled entirely by docHitProxy
  docPoints.userData.kind = 'doc-points';
  // While orbiting, the absolute coordinates keep changing, so frustum culling against the initial bounding sphere
  // could wrongly judge them off-screen and make them invisible at certain camera angles — disabled.
  docPoints.frustumCulled = false;
  scene.add(docPoints);

  const dummy = new THREE.Object3D();
  const docHitGeom = new THREE.SphereGeometry(1, 8, 6);
  const docHitMat = new THREE.MeshBasicMaterial({ visible: false });
  const docHitProxy = new THREE.InstancedMesh(docHitGeom, docHitMat, Math.max(docs.length, 1));
  // Since the doc points orbit every frame, the hit-proxy matrices are also updated every frame — static → dynamic.
  docHitProxy.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  docs.forEach((d, i) => {
    dummy.position.set(d.pos[0], d.pos[1], d.pos[2]);
    dummy.scale.setScalar(Math.max(docScales[i] * 1.8, 1.4)); // Slightly larger than the point itself — gives extra margin for clicking
    dummy.updateMatrix();
    docHitProxy.setMatrixAt(i, dummy.matrix);
  });
  docHitProxy.instanceMatrix.needsUpdate = true;
  docHitProxy.userData.kind = 'doc-hit-proxy';
  scene.add(docHitProxy);

  // Afterglow ratio for the locked dim-out state — brighter than full blackout so the gray nebula stays identifiable.
  // (Declared before the line layer since the relationship-line color calc also references it.)
  const LOCK_LIGHT = 0.35;
  const DOC_LOCK_LIGHT = 0.45;

  // ---- M10 relationship lines: renders [[links]] between doc points as subtle lines (additive blending) ----
  // Positions are copied each frame from docCurrentPos (the single source of truth for orbiting), so points and lines
  // never drift apart. Color is only recomputed on state changes (default/selection-highlight/lock-grayscale).
  const LINK_BASE = 0.16;   // Always-on display intensity (additive, so overlaps get brighter)
  const LINK_FOCUS = 0.9;   // Lines touching the selected document
  const LINK_FADE = 0.05;   // Remaining lines while something is selected
  const docIndexById = new Map(docs.map((d, i) => [d.doc_id, i]));
  const docLinks = (data.links ?? [])
    .map((l) => ({ a: docIndexById.get(l.src), b: docIndexById.get(l.dst), rel_type: l.rel_type }))
    .filter((l) => l.a !== undefined && l.b !== undefined && l.a !== l.b);
  const linkPositions = new Float32Array(docLinks.length * 6);
  const linkColors = new Float32Array(docLinks.length * 6);
  const linkGeom = new THREE.BufferGeometry();
  linkGeom.setAttribute('position', new THREE.BufferAttribute(linkPositions, 3));
  linkGeom.setAttribute('color', new THREE.BufferAttribute(linkColors, 3));
  const linkMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const linkLines = new THREE.LineSegments(linkGeom, linkMat);
  linkLines.frustumCulled = false; // Absolute coordinates keep changing due to orbiting — same reason as the doc points
  linkLines.raycast = () => {}; // Ignored for picking (prevents accidental clicks on thin lines)
  linkLines.userData.kind = 'doc-links';
  let linksEnabled = false; // Display option toggle — off by default (user decision 2026-07-22), app.js applies the stored value
  let linkFocusIndex = null; // Selected document index (only that document's lines are highlighted), null=default for all
  linkLines.visible = false;
  scene.add(linkLines);

  function writeLinkEndColor(offset, docIdx, intensity) {
    let r = docBaseColors[docIdx * 3 + 0];
    let g = docBaseColors[docIdx * 3 + 1];
    let b = docBaseColors[docIdx * 3 + 2];
    // Endpoints belonging to a locked/dimmed cluster get the same gray-afterglow rule as the doc points.
    const entry = docClusterEntry[docIdx];
    if (entry && entry.lightsOut) {
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) * DOC_LOCK_LIGHT;
      r = lum; g = lum; b = lum;
    }
    linkColors[offset + 0] = r * intensity;
    linkColors[offset + 1] = g * intensity;
    linkColors[offset + 2] = b * intensity;
  }

  function refreshLinkColors() {
    for (let li = 0; li < docLinks.length; li++) {
      const { a, b, rel_type } = docLinks[li];
      let k = LINK_BASE;
      if (linkFocusIndex !== null) {
        k = a === linkFocusIndex || b === linkFocusIndex ? LINK_FOCUS : LINK_FADE;
      }
      if (rel_type === 'up') k *= 1.35; // Hierarchical relations are made slightly more distinct
      writeLinkEndColor(li * 6 + 0, a, k);
      writeLinkEndColor(li * 6 + 3, b, k);
    }
    if (docLinks.length) linkGeom.attributes.color.needsUpdate = true;
  }
  refreshLinkColors();

  function setLinksVisible(on) {
    linksEnabled = !!on;
    linkLines.visible = linksEnabled && docLinks.length > 0;
  }
  function getLinksVisible() {
    return linksEnabled;
  }
  function setLinkFocus(index) {
    linkFocusIndex = typeof index === 'number' && index >= 0 ? index : null;
    refreshLinkColors();
  }

  const raycastTargets = [...clusterEntries.map((c) => c.core), docHitProxy];
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  function raycastAtClient(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(raycastTargets, false);
    if (hits.length === 0) return null;
    // Documents always sit inside their cluster's proxy sphere (radius c.radius*0.85), so a naive
    // "closest hit along the ray" priority would always hit the sphere's surface before the document,
    // making individual documents impossible to click (a ray reaching a point inside the sphere must
    // always pass through the sphere's surface first, so the surface is always closer). When a more
    // specific doc hit exists, it takes priority over the cluster — the cluster proxy is only used
    // for clicks on empty areas with no document.
    const docHit = hits.find((h) => h.object === docHitProxy);
    const hit = docHit || hits[0];
    if (hit.object === docHitProxy) {
      const doc = docs[hit.instanceId];
      return doc ? { type: 'doc', data: doc, index: hit.instanceId, point: hit.point } : null;
    }
    if (hit.object.userData.kind === 'cluster') {
      return { type: 'cluster', data: hit.object.userData.data, object: hit.object, point: hit.point };
    }
    return null;
  }

  function lightFactor(entry) {
    return entry.lightsOut ? LOCK_LIGHT : 1;
  }

  // Gray glow texture for the locked dim-out state (shared across all clusters, created once).
  let grayGlowTex = null;
  function getGrayGlowTex() {
    if (!grayGlowTex) {
      grayGlowTex = new THREE.CanvasTexture(makeGlowCanvas(0x8b919c));
      if ('colorSpace' in grayGlowTex) grayGlowTex.colorSpace = THREE.SRGBColorSpace;
    }
    return grayGlowTex;
  }

  function setGlowGray(sprite, gray) {
    if (!sprite.userData.baseMap) sprite.userData.baseMap = sprite.material.map;
    sprite.material.map = gray ? getGrayGlowTex() : sprite.userData.baseMap;
  }

  function setClusterDim(slug, dimAmount, duration = 500) {
    const entry = clusterBySlug.get(slug);
    if (!entry) return;
    const uniforms = entry.nebula.material.uniforms;
    const lf = lightFactor(entry);
    const targetDim = entry.nebula.userData.baseDim * dimAmount * lf;
    animateValue(uniforms.uDim.value, targetDim, duration, (v) => {
      uniforms.uDim.value = v;
    });
    animateValue(entry.glowNear.material.opacity, entry.glowNear.userData.baseOpacity * dimAmount * lf, duration, (v) => {
      entry.glowNear.material.opacity = v;
    });
    animateValue(entry.glowFar.material.opacity, entry.glowFar.userData.baseOpacity * dimAmount * lf, duration, (v) => {
      entry.glowFar.material.opacity = v;
    });
    if (entry.personalRing) {
      animateValue(entry.personalRing.material.opacity, 0.55 * dimAmount * lf, duration, (v) => {
        entry.personalRing.material.opacity = v;
      });
    }
  }

  function restoreCluster(slug, duration = 600) {
    const entry = clusterBySlug.get(slug);
    if (!entry) return;
    const lf = lightFactor(entry);
    const uniforms = entry.nebula.material.uniforms;
    animateValue(uniforms.uDim.value, entry.nebula.userData.baseDim * lf, duration, (v) => {
      uniforms.uDim.value = v;
    });
    animateValue(entry.glowNear.material.opacity, entry.glowNear.userData.baseOpacity * lf, duration, (v) => {
      entry.glowNear.material.opacity = v;
    });
    animateValue(entry.glowFar.material.opacity, entry.glowFar.userData.baseOpacity * lf, duration, (v) => {
      entry.glowFar.material.opacity = v;
    });
    if (entry.personalRing) {
      animateValue(entry.personalRing.material.opacity, 0.55 * lf, duration, (v) => {
        entry.personalRing.material.opacity = v;
      });
    }
  }

  function flashCluster(slug) {
    const entry = clusterBySlug.get(slug);
    if (!entry) return Promise.resolve();
    return new Promise((resolve) => {
      const uniforms = entry.nebula.material.uniforms;
      const peak = entry.nebula.userData.baseBoost * 2.6;
      animateValue(entry.nebula.userData.baseBoost, peak, 180, (v) => {
        uniforms.uBoost.value = v;
      }, () => {
        animateValue(peak, entry.nebula.userData.baseBoost, 320, (v) => {
          uniforms.uBoost.value = v;
        }, resolve);
      });
      animateValue(1, 1.3, 180, (v) => {
        entry.nebula.scale.setScalar(v);
      }, () => {
        animateValue(1.3, 1, 320, (v) => {
          entry.nebula.scale.setScalar(v);
        });
      });
    });
  }

  function spawnPulse(fromArr, toArr, colorHex, duration = 650) {
    return new Promise((resolve) => {
      const from = fromArr instanceof THREE.Vector3 ? fromArr : new THREE.Vector3(...fromArr);
      const to = toArr instanceof THREE.Vector3 ? toArr : new THREE.Vector3(...toArr);
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(1.7, 12, 12),
        new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.95 })
      );
      mesh.raycast = () => {};
      const glow = buildGlowSprite(colorHex, 11, 0.65);
      mesh.add(glow);
      mesh.position.copy(from);
      scene.add(mesh);
      const dist = from.distanceTo(to);
      const start = performance.now();
      function step(now) {
        const t = clamp((now - start) / duration, 0, 1);
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        mesh.position.lerpVectors(from, to, eased);
        mesh.position.y += Math.sin(Math.PI * t) * dist * 0.1;
        if (t < 1) {
          requestAnimationFrame(step);
        } else {
          scene.remove(mesh);
          mesh.geometry.dispose();
          mesh.material.dispose();
          resolve();
        }
      }
      requestAnimationFrame(step);
    });
  }

  function pulseBeacon(active) {
    animateValue(beaconCore.material.opacity, active ? 0.85 : 0.35, 400, (v) => {
      beaconCore.material.opacity = v;
      beaconGlow.material.opacity = active ? v * 0.5 : 0.22;
    });
  }

  // Click-selection indicator — used to be a rotating torus ring, but per request the ring was
  // removed and replaced with a sine pulse where the selected target itself (nebula core particles
  // or a doc point) gently brightens and dims on a ~2s cycle. The actual brightness calc is handled
  // by the GPU shader (uSelectPulse / uHighlightIndex+uHighlightFade); here we just hold the state
  // of "what's currently selected" and smoothly turn that uniform on/off via tick() and the fade tween.
  let selectedClusterSlug = null;
  function restoreSelectPulse(slug) {
    const entry = clusterBySlug.get(slug);
    if (!entry) return;
    const uniforms = entry.nebula.material.uniforms;
    animateValue(uniforms.uSelectPulse.value, 1, 400, (v) => {
      uniforms.uSelectPulse.value = v;
    });
  }
  function highlightCluster(slug) {
    if (selectedClusterSlug && selectedClusterSlug !== slug) {
      restoreSelectPulse(selectedClusterSlug);
    }
    selectedClusterSlug = slug;
  }
  function clearClusterHighlight() {
    if (selectedClusterSlug) {
      restoreSelectPulse(selectedClusterSlug);
      selectedClusterSlug = null;
    }
  }
  function highlightDocByIndex(index) {
    docMat.uniforms.uHighlightIndex.value = index;
    animateValue(docMat.uniforms.uHighlightFade.value, 1, 220, (v) => {
      docMat.uniforms.uHighlightFade.value = v;
    });
    setLinkFocus(index); // Highlights the selected document's relationship lines (dims the rest)
  }
  function clearDocHighlight() {
    animateValue(docMat.uniforms.uHighlightFade.value, 0, 380, (v) => {
      docMat.uniforms.uHighlightFade.value = v;
    }, () => {
      docMat.uniforms.uHighlightIndex.value = -1;
    });
    setLinkFocus(null);
  }

  function focusOn(posArr, distanceHint = 60) {
    const target = new THREE.Vector3(...posArr);
    const dir = camera.position.clone().sub(controls.target).normalize();
    const newCamPos = target.clone().add(dir.multiplyScalar(distanceHint));
    const fromCam = camera.position.clone();
    const fromTarget = controls.target.clone();
    animateValue(0, 1, 700, (t) => {
      camera.position.lerpVectors(fromCam, newCamPos, t);
      controls.target.lerpVectors(fromTarget, target, t);
    });
  }

  function resetView() {
    const fromCam = camera.position.clone();
    const fromTarget = controls.target.clone();
    animateValue(0, 1, 700, (t) => {
      camera.position.lerpVectors(fromCam, initialCameraPos, t);
      controls.target.lerpVectors(fromTarget, new THREE.Vector3(0, 0, 0), t);
    });
  }

  function getClusterWorldPos(slug) {
    const entry = clusterBySlug.get(slug);
    return entry ? entry.core.position.clone() : new THREE.Vector3(0, 0, 0);
  }
  function getDocWorldPos(index) {
    // Returns the current orbiting position (docCurrentPos, updated every frame by tick(),
    // not the static coordinate d.pos) — so citation clicks don't send the camera to an empty old spot.
    const v = docCurrentPos[index];
    return v ? v.clone() : new THREE.Vector3(0, 0, 0);
  }
  function getBeaconWorldPos() {
    return beaconGroup.position.clone();
  }

  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    labelRenderer.setSize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener('resize', onResize);

  const clock = new THREE.Clock();
  let rafId = 0;
  let prevElapsed = 0;
  function tick() {
    rafId = requestAnimationFrame(tick);
    const elapsed = clock.getElapsedTime();
    const dt = elapsed - prevElapsed;
    prevElapsed = elapsed;
    starField.material.uniforms.uTime.value = elapsed;
    beaconGroup.rotation.y = elapsed * 0.15;
    clusterEntries.forEach((entry) => {
      // Motion lock: a locked cluster's own motion clock stops, freezing it in place,
      // and unlocking resumes from the paused phase (using elapsed directly would cause a jump — forbidden).
      if (entry.motionEnabled) entry.motionTime += dt;
      const mt = entry.motionTime;
      entry.nebula.rotation.y = mt * entry.rotSpeed;
      entry.nebula.material.uniforms.uBreath.value = 0.94 + 0.06 * Math.sin(mt * entry.breathSpeed + entry.breathPhase);
      entry.nebula.material.uniforms.uTime.value = mt; // Per-particle orbital phase (computed in the vertex shader)
      // Only while the selected cluster is alive do we push a sine value into the uniform every frame
      // (2s period, angular velocity π rad/s). Deselection is handled by clearClusterHighlight()'s
      // animateValue tween, so this never touches an unselected cluster —
      // it's a completely separate path from uBoost(flashCluster) / uDim(setClusterDim/restoreCluster).
      // The select pulse is interaction feedback, so it uses the global clock regardless of motion lock.
      if (selectedClusterSlug === entry.slug) {
        entry.nebula.material.uniforms.uSelectPulse.value = 0.6 + 0.6 * Math.sin(elapsed * Math.PI);
      }
    });
    // Doc point orbit (CPU-computed) — the position buffer and the hit-proxy matrix are updated
    // from the same single computed value, so the visual position and click hit-testing never
    // drift apart (single source of truth). raycastAtClient()'s child-first logic remains
    // unaffected by this update. A document's orbit follows its cluster's motion clock (also frozen when locked).
    for (let i = 0; i < docs.length; i++) {
      const clockSrc = docClusterEntry[i] ? docClusterEntry[i].motionTime : elapsed;
      const angle = docBaseAngle[i] + clockSrc * docOrbitSpeed[i];
      const x = docCenterX[i] + Math.cos(angle) * docRadiusXZ[i];
      const z = docCenterZ[i] + Math.sin(angle) * docRadiusXZ[i];
      const y = docCenterY[i] + docOffsetY[i];
      docCurrentPos[i].set(x, y, z);
      docPositions[i * 3 + 0] = x;
      docPositions[i * 3 + 1] = y;
      docPositions[i * 3 + 2] = z;
      dummy.position.set(x, y, z);
      dummy.scale.setScalar(Math.max(docScales[i] * 1.8, 1.4));
      dummy.updateMatrix();
      docHitProxy.setMatrixAt(i, dummy.matrix);
    }
    docGeom.attributes.position.needsUpdate = true;
    docHitProxy.instanceMatrix.needsUpdate = true;
    // Updates both ends of each relationship line with the same per-frame value (docCurrentPos) as the doc points — eliminates any chance of drift.
    if (linkLines.visible) {
      for (let li = 0; li < docLinks.length; li++) {
        const pa = docCurrentPos[docLinks[li].a];
        const pb = docCurrentPos[docLinks[li].b];
        linkPositions[li * 6 + 0] = pa.x;
        linkPositions[li * 6 + 1] = pa.y;
        linkPositions[li * 6 + 2] = pa.z;
        linkPositions[li * 6 + 3] = pb.x;
        linkPositions[li * 6 + 4] = pb.y;
        linkPositions[li * 6 + 5] = pb.z;
      }
      if (docLinks.length) linkGeom.attributes.position.needsUpdate = true;
    }
    docMat.uniforms.uTime.value = elapsed;
    controls.update();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  }
  tick();

  function dispose() {
    cancelAnimationFrame(rafId);
    window.removeEventListener('resize', onResize);
    controls.dispose();
    renderer.dispose();
  }

  /** M9.5: Cluster motion lock/unlock — called by the top-left checkbox UI. */
  function setClusterMotion(slug, enabled) {
    const entry = clusterBySlug.get(slug);
    if (!entry) return;
    entry.motionEnabled = !!enabled;
  }

  function getClusterMotion(slug) {
    const entry = clusterBySlug.get(slug);
    return entry ? entry.motionEnabled : true;
  }

  /**
   * Locked dim-out = grayscale: when off, the nebula goes desaturated (uSaturation→0) with an
   * afterglow (LOCK_LIGHT), the glow switches to a gray texture, and the personal ring, member
   * doc points, and label all turn gray too. When on, everything reverts to its original color.
   * This composes with the search highlight's dim/restore via a lightFactor multiplication, so
   * the dim-out state stays in effect regardless of which path runs last.
   */
  function setClusterLight(slug, on) {
    const entry = clusterBySlug.get(slug);
    if (!entry) return;
    entry.lightsOut = !on;
    entry.label.element.classList.toggle('cluster-label-lights-out', !on);

    const uniforms = entry.nebula.material.uniforms;
    animateValue(uniforms.uSaturation.value, on ? 1 : 0, 500, (v) => {
      uniforms.uSaturation.value = v;
    });
    setGlowGray(entry.glowNear, !on);
    setGlowGray(entry.glowFar, !on);
    if (entry.personalRing) {
      entry.personalRing.material.color.set(on ? entry.color : 0x8b919c);
    }
    restoreCluster(slug, 500);

    const indices = docIndicesBySlug.get(slug) ?? [];
    for (const i of indices) {
      const r = docBaseColors[i * 3 + 0];
      const g = docBaseColors[i * 3 + 1];
      const b = docBaseColors[i * 3 + 2];
      if (on) {
        docColors[i * 3 + 0] = r;
        docColors[i * 3 + 1] = g;
        docColors[i * 3 + 2] = b;
      } else {
        // Grayscale: unify all 3 channels to a single luminance value, times the afterglow factor
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) * DOC_LOCK_LIGHT;
        docColors[i * 3 + 0] = lum;
        docColors[i * 3 + 1] = lum;
        docColors[i * 3 + 2] = lum;
      }
    }
    if (indices.length) docGeom.attributes.color.needsUpdate = true;
    refreshLinkColors(); // Relationship lines touching a dimmed cluster get grayscaled under the same rule
  }

  function getClusterLight(slug) {
    const entry = clusterBySlug.get(slug);
    return entry ? !entry.lightsOut : true;
  }

  return {
    scene,
    camera,
    renderer,
    controls,
    clusterEntries,
    docs,
    docPoints,
    raycastAtClient,
    setClusterMotion,
    getClusterMotion,
    setClusterLight,
    getClusterLight,
    setLinksVisible,
    getLinksVisible,
    setLinkFocus,
    linkCount: docLinks.length,
    setClusterDim,
    restoreCluster,
    flashCluster,
    spawnPulse,
    pulseBeacon,
    highlightDocByIndex,
    clearDocHighlight,
    highlightCluster,
    clearClusterHighlight,
    focusOn,
    resetView,
    getClusterWorldPos,
    getDocWorldPos,
    getBeaconWorldPos,
    dispose,
  };
}
