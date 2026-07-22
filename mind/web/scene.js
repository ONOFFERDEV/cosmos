// three.js 장면 구성 + 렌더 루프. 데이터 페칭/DOM 패널 로직은 다루지 않는다 (관심사 분리: app.js/interactions.js/ask.js가 담당).
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

// 클러스터 피킹/라벨앵커용 비가시 히트 프록시. 성운 파티클 자체는 raycast를 받지 않으므로
// 클릭 판정 범위를 구체 하나로 안정화한다 (기존 코어 메시가 하던 raycastTargets/label anchor 역할 승계).
function buildClusterHitProxy(c) {
  const geom = new THREE.SphereGeometry(Math.max(c.radius * 0.85, 3), 12, 8);
  const mat = new THREE.MeshBasicMaterial({ visible: false });
  const mesh = new THREE.Mesh(geom, mat);
  return mesh;
}

// 성운 파티클 셰이더: 원형 스프라이트 대신 각도에 따라 굴곡진 블롭 경계를 절차적으로 그려
// (텍스처 없이) 낱개 입자부터 경계가 또렷하지 않은 가스 덩어리로 읽히게 한다.
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
  // 선택 펄스: 클릭으로 선택된 클러스터일 때만 코어 파티클(aIsCore=1)에 곱해지고
  // 나머지 파티클·비선택 상태에서는 mix()가 1.0을 반환해 완전 무영향(uBoost/uDim/
  // uBreath와 독립된 별도 승수라 기존 flashCluster·setClusterDim과 간섭하지 않는다).
  uniform float uSelectPulse;
  void main() {
    vColor = color;
    vAlpha = aAlpha * uDim * uBreath * mix(1.0, uSelectPulse, aIsCore);
    vSeed = aSeed;

    // 파티클별 개별 공전: 시드로 뽑은 축(aOrbitAxis) 둘레로 시간에 따라 회전시켜
    // 각자 다른 궤도 평면·속도로 성운 중심(로컬 원점)을 돌게 한다 — 로드리게스
    // 회전 공식은 항등적으로 반경을 보존하므로 별도 궤도 반경 값 없이 기존
    // position의 중심 거리 자체가 그대로 궤도 반경이 된다. CPU는 uTime 스칼라
    // 하나만 매 프레임 올리고 실제 위치 계산은 전부 GPU 정점 단계에서 수행.
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
  // 잠금 소등 회색화: 1=원색, 0=무채색(휘도만). setClusterLight가 애니메이션한다.
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

// 클러스터 하나를 부피감 있는 성운 파티클 구름으로 만든다. 중심핵(작고 밝음)과 본체(반경 안쪽으로
// 밀도 편향 분포, 바깥으로 갈수록 성기고 옅음)를 한 Points 드로우콜로 그려 클러스터당 draw call을 아낀다.
// 배치는 해시 시드 PRNG로 결정론적으로 고정된다(Math.random 미사용 — 새로고침/재실행해도 동일 모양).
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
    const rr = radius * spread * Math.pow(rand(), 1.5); // 중심 밀도 편향(부피 채움, 표면 셸 아님)
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

    // 공전 축·속도도 동일한 시드 스트림에서 결정론으로 파생(Math.random 미사용).
    // 축을 위치 벡터와 무관하게 구면 균등 샘플링해서 파티클마다 서로 다른 궤도
    // 평면을 갖게 한다 — 반경은 별도로 두지 않고 로드리게스 회전이 |position|을
    // 그대로 보존하므로 이미 계산된 중심 거리(rr)가 곧 궤도 반경이 된다.
    const axTheta = rand() * Math.PI * 2;
    const axPhi = Math.acos(2 * rand() - 1);
    orbitAxes[i * 3 + 0] = Math.sin(axPhi) * Math.cos(axTheta);
    orbitAxes[i * 3 + 1] = Math.cos(axPhi);
    orbitAxes[i * 3 + 2] = Math.sin(axPhi) * Math.sin(axTheta);
    const orbitDir = rand() < 0.5 ? -1 : 1;
    orbitSpeeds[i] = orbitDir * (0.025 + rand() * 0.09); // rad/s → 한 바퀴 약 40s~250s(천천히)

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

// M9: 개인 클러스터 구분 링 — 성운 바깥 궤도의 점선 링으로 개인 소유 공간임을 표시한다.
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

  // 관측소 코어 비콘 — 질의가 발사되는 원점을 상징. 평상시엔 은은하게, 질의 중엔 밝게.
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

    // 은은한 개별 회전/맥동 주기 — 클러스터마다 다르게 결정론으로 뽑아 동조되어 보이지 않게 한다.
    const motionRand = seededRandom(`${c.slug}:motion`);
    const rotSpeed = (motionRand() < 0.5 ? -1 : 1) * (0.015 + motionRand() * 0.035); // rad/s, 2~7분에 한 바퀴
    const breathSpeed = 0.7 + motionRand() * 0.9; // rad/s, 약 4~9초 주기
    const breathPhase = motionRand() * Math.PI * 2;

    clusterGroup.add(core, nebula, glowNear, glowFar);

    const entry = {
      slug: c.slug, data: c, core, nebula, glowNear, glowFar, label, color: hue, personalRing,
      dimTweenId: 0, rotSpeed, breathSpeed, breathPhase,
      // 클러스터별 동작 잠금: 자전·맥동·파티클 공전·소속 문서 궤도가 이 시계를
      // 공유한다. 잠그면 시계가 멈추고, 해제하면 멈춘 지점부터 이어져 튐이 없다.
      motionEnabled: true, motionTime: 0,
      // 잠금 시 소등: true면 성운·글로우·링·라벨·소속 문서가 잔광 수준으로 어두워진다.
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

  // 문서 입자 — 별처럼 보이는 점 광원(Points). 이전엔 InstancedMesh 구체였는데
  // 3D 입체로 읽혀서(회전해도 부피감이 두드러짐) 점 하나짜리 별빛으로 교체한다.
  // 성운(buildNebulaCloud)과 달리 각도 굴곡(blob wobble)을 넣지 않고 단단한 원형
  // 코어 + 아주 짧은 가장자리 페이드만 써서 "덩어리"가 아니라 낱개 점으로 읽히게 한다.
  // 클릭/호버 판정은 별도 비가시 InstancedMesh 프록시가 전담(Points의 레이캐스트
  // threshold는 화면 투영 크기가 아니라 월드 단위라 줌 레벨마다 판정이 불안정해지므로,
  // 클러스터 히트 프록시와 동일한 검증된 패턴을 재사용). 이 프록시는 vertexColors를
  // 전혀 쓰지 않으므로 InstancedMesh+vertexColors 조합의 검정 렌더링 함정과 무관하다.
  // aDocIndex: 문서 하나당 고유 정수(0..N-1)를 실어 두고, 선택된 문서 인덱스와
  // 셰이더 안에서 비교(step)해 딱 한 점만 골라 펄스를 먹인다. 위치는 절대 바꾸지
  // 않으므로(크기/밝기만 변화) docHitProxy의 정적 인스턴스 행렬과 어긋날 일이 없다.
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
      // 2초 주기(각속도 = 2π/2s = π rad/s) 사인 펄스, 0..1을 부드럽게 왕복 —
      // 급격한 on/off 없이 서서히 밝아졌다 어두워진다. 선택 안 된 점은 isHi=0이라
      // vGlow도 항상 0으로, 렌더링에 전혀 영향이 없다. uHighlightFade는 선택/해제
      // 전환 자체를 부드럽게 감싸는 별도 승수(CPU에서 tween) — 펄스와 독립적으로
      // 켜짐/꺼짐 전환의 급격함만 제거한다.
      float pulse = 0.5 + 0.5 * sin(uTime * 3.14159265);
      vGlow = isHi * pulse * uHighlightFade;

      // 미세 반짝임: aDocIndex/aSize를 해시해 파티클마다 다른 위상(과 살짝 다른 주파수)을
      // 뽑는다 — Math.random 없이 GPU에서 순수 함수로 매 프레임 재계산되는 결정론 시드.
      // 진폭은 ±15%(0.85~1.15)로 억제해 "미세하게" 떨리는 정도만 표현한다.
      float seed = fract(sin(aDocIndex * 12.9898 + aSize * 78.233) * 43758.5453);
      vTwinkle = 1.0 + 0.15 * sin(uTime * (1.6 + seed * 0.8) + seed * 6.2831853);

      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      // 십자 회절 스파이크가 뻗어나갈 여유 공간을 확보하기 위해 코어 크기를 1.8배
      // 키운다 — docHitProxy(클릭 판정)는 별도 InstancedMesh 스케일(dummy.scale, JS
      // 쪽 docScales 기반)을 쓰므로 이 값과 완전히 무관, 클릭 판정 크기는 불변이다.
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

      // 코어: 중심 소구역을 흰색 쪽으로 끌어올린 고휘도 스팟(실제 별의 뜨거운 중심부를 흉내).
      float core = smoothstep(0.16, 0.0, d);
      vec3 coreColor = mix(vColor, vec3(1.0), 0.82);

      // halo: source_type 색이 그대로 실리는 지수 감쇠 글로우 — 코어 밖으로 퍼지며
      // 옅어진다. 범례(session=teal/arxiv=purple/rss=orange/manual=off-white) 대조는
      // 이 halo가 전담한다(코어는 흰색에 가까워 색 구분에 쓰지 않는다).
      float halo = exp(-d * 6.5);

      // 십자 회절 스파이크: 두 축을 따라 가늘게 뻗는 빛줄기. pow()로 축을 벗어날수록
      // 급격히 좁아지고 exp()로 축을 따라 멀어질수록 옅어진다 — 별 사진의 회절
      // 아티팩트를 흉내낸 절차적 스파이크(텍스처 미사용, 은은하게 0.5 승수로 억제).
      // 선택 펄스(vGlow) 중에는 축 방향 감쇠를 완만하게 풀어 스파이크가 살짝 더
      // 길어지는 연출을 더한다.
      float armFade = 4.5 - vGlow * 1.8;
      float armV = pow(clamp(1.0 - abs(uv.x) * 22.0, 0.0, 1.0), 1.8) * exp(-abs(uv.y) * armFade);
      float armH = pow(clamp(1.0 - abs(uv.y) * 22.0, 0.0, 1.0), 1.8) * exp(-abs(uv.x) * armFade);
      float spikes = (armV + armH) * 0.5;

      vec3 starColor = mix(vColor * halo, coreColor, core);
      starColor += (vColor * 0.6 + vec3(0.4)) * spikes;
      // 선택 펄스는 색까지 흰 쪽으로 더 끌어올려 또렷하게 밝아지는 인상을 준다(기존 동작 유지).
      starColor = mix(starColor, vec3(1.0), vGlow * 0.6);

      // R5~R6에서 확정한 "기본 반투명 0.55 / 선택 시 최대 1.0" 알파 규칙은 그대로 유지하되,
      // 이제 그 알파가 적용되는 대상은 "별의 형태"(코어+halo+스파이크) 실루엣 전체다.
      // vTwinkle(±15%)을 곱해 미세한 밝기 떨림을 더한다.
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
  // 문서 점 공전 파라미터(CPU 계산, 단일 진실 원천). 클러스터 중심 기준
  // 반경(XZ)·y오프셋은 원본 d.pos에서 고정 도출해 "적합도 낮을수록 바깥 궤도"
  // 의미를 보존하고, 각도만 시간에 따라 회전시킨다. 성운(정점 셰이더 공전)과
  // 달리 docHitProxy·getDocWorldPos가 참조할 수 있어야 하므로 매 프레임 CPU에서
  // 갱신하고, 그 값을 위치 버퍼와 히트 프록시 행렬에 동일하게 흘려보낸다.
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
    docClusterEntry[i] = clusterEntry ?? null; // 동작 잠금 시계 참조(무소속 문서는 전역 시계)
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
    // rad/s — 한 바퀴 약 2~5분(성운의 40~250s보다 느리게: 문서는 차분히 읽히도록).
    docOrbitSpeed[i] = orbitDir * (0.021 + orbitRand() * 0.031);
    docCurrentPos[i] = new THREE.Vector3(d.pos[0], d.pos[1], d.pos[2]);
  });

  // 소등 복원용 원본 색 + 클러스터별 소속 문서 인덱스(잠금 시 문서 점도 함께 어두워진다).
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
  docPoints.raycast = () => {}; // 피킹은 docHitProxy가 전담
  docPoints.userData.kind = 'doc-points';
  // 공전 중엔 절대좌표가 계속 바뀌므로 최초 바운딩 스피어로 프러스텀 컬링하면
  // 화면 밖에 있다고 잘못 판단해 안 보이는 카메라 각도가 생길 수 있다 — 비활성화.
  docPoints.frustumCulled = false;
  scene.add(docPoints);

  const dummy = new THREE.Object3D();
  const docHitGeom = new THREE.SphereGeometry(1, 8, 6);
  const docHitMat = new THREE.MeshBasicMaterial({ visible: false });
  const docHitProxy = new THREE.InstancedMesh(docHitGeom, docHitMat, Math.max(docs.length, 1));
  // 문서 점이 매 프레임 공전하므로 히트 프록시 행렬도 매 프레임 갱신된다 — 정적 → 동적.
  docHitProxy.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  docs.forEach((d, i) => {
    dummy.position.set(d.pos[0], d.pos[1], d.pos[2]);
    dummy.scale.setScalar(Math.max(docScales[i] * 1.8, 1.4)); // 점보다 살짝 넉넉하게 — 클릭 여유 확보
    dummy.updateMatrix();
    docHitProxy.setMatrixAt(i, dummy.matrix);
  });
  docHitProxy.instanceMatrix.needsUpdate = true;
  docHitProxy.userData.kind = 'doc-hit-proxy';
  scene.add(docHitProxy);

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
    // 문서는 항상 소속 클러스터 프록시 구(반경 c.radius*0.85) 안쪽에 위치하므로, 단순
    // "레이 상 가장 가까운 히트" 우선순위로는 그 구의 표면이 문서보다 먼저 걸려 개별
    // 문서를 절대 클릭할 수 없다(레이가 구 내부의 한 점에 닿으려면 반드시 그 전에 구
    // 표면을 통과해야 하므로 항상 더 가까움). 더 구체적인 타겟인 문서 히트가 있으면
    // 그것을 클러스터보다 우선한다 — 클러스터 프록시는 문서가 없는 빈 영역 클릭에만
    // 쓰인다.
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

  // 잠금 소등 상태의 잔광 비율 — 회색 성운이 식별되도록 완전 암전보다 밝게.
  const LOCK_LIGHT = 0.35;
  const DOC_LOCK_LIGHT = 0.45;

  function lightFactor(entry) {
    return entry.lightsOut ? LOCK_LIGHT : 1;
  }

  // 잠금 소등용 회색 글로우 텍스처(전 클러스터 공유, 최초 1회 생성).
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

  // 클릭 선택 표시 — 이전엔 회전하는 토러스 고리였는데, 요청에 따라 고리를 걷어내고
  // 선택된 대상 자체(성운 코어 파티클 또는 문서 점)가 ~2초 주기로 은은하게 밝아졌다
  // 어두워지는 사인 펄스로 대체한다. 실제 밝기 계산은 GPU 셰이더(uSelectPulse /
  // uHighlightIndex+uHighlightFade)가 담당하고, 여기서는 "지금 무엇이 선택됐는가"
  // 상태만 들고 tick()과 fade 트윈을 통해 그 우니폼을 부드럽게 켜고 끈다.
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
  }
  function clearDocHighlight() {
    animateValue(docMat.uniforms.uHighlightFade.value, 0, 380, (v) => {
      docMat.uniforms.uHighlightFade.value = v;
    }, () => {
      docMat.uniforms.uHighlightIndex.value = -1;
    });
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
    // 공전 중인 현재 위치를 반환한다(정지 좌표 d.pos가 아니라 tick()이 매 프레임
    // 갱신하는 docCurrentPos) — 출처 인용 클릭이 빈 옛 위치로 카메라를 보내지 않도록.
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
      // 동작 잠금: 잠긴 클러스터는 자기 모션 시계가 멈춰 그 자리에 정지하고,
      // 해제하면 멈춘 위상부터 이어진다(elapsed 직접 사용 시 점프 발생 — 금지).
      if (entry.motionEnabled) entry.motionTime += dt;
      const mt = entry.motionTime;
      entry.nebula.rotation.y = mt * entry.rotSpeed;
      entry.nebula.material.uniforms.uBreath.value = 0.94 + 0.06 * Math.sin(mt * entry.breathSpeed + entry.breathPhase);
      entry.nebula.material.uniforms.uTime.value = mt; // 파티클별 공전 위상(정점 셰이더에서 계산)
      // 선택된 클러스터만 살아있는 동안 매 프레임 사인값을 우니폼에 밀어넣는다(2초
      // 주기, 각속도 π rad/s). 선택 해제는 clearClusterHighlight()의 animateValue
      // 트윈이 담당하므로 여기서는 선택되지 않은 클러스터를 절대 건드리지 않는다 —
      // uBoost(flashCluster)·uDim(setClusterDim/restoreCluster)과는 완전히 별개 경로.
      // 선택 펄스는 상호작용 피드백이라 동작 잠금과 무관하게 전역 시계를 쓴다.
      if (selectedClusterSlug === entry.slug) {
        entry.nebula.material.uniforms.uSelectPulse.value = 0.6 + 0.6 * Math.sin(elapsed * Math.PI);
      }
    });
    // 문서 점 공전(CPU 계산) — 위치 버퍼와 히트 프록시 행렬을 같은 계산값 하나로
    // 갱신해 시각 위치와 클릭 판정이 절대 어긋나지 않게 한다(단일 진실 원천).
    // raycastAtClient()의 자식-우선 로직은 이 갱신과 무관하게 그대로 유지된다.
    // 문서 궤도는 소속 클러스터의 모션 시계를 따른다(잠금 시 문서도 정지).
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

  /** M9.5: 클러스터 동작 잠금/해제 — 좌상단 체크박스 UI가 호출한다. */
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
   * 잠금 소등 = 회색화: off면 성운이 무채색(uSaturation→0)+잔광(LOCK_LIGHT)으로,
   * 글로우는 회색 텍스처로, 개인 링·소속 문서 점·라벨도 회색으로 변한다.
   * on이면 전부 원색 복귀. 검색 하이라이트의 dim/restore와는 lightFactor
   * 곱으로 합성되므로 어느 경로가 나중에 실행돼도 소등 상태가 유지된다.
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
        // 회색화: 휘도 하나로 3채널 통일 + 잔광 배율
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) * DOC_LOCK_LIGHT;
        docColors[i * 3 + 0] = lum;
        docColors[i * 3 + 1] = lum;
        docColors[i * 3 + 2] = lum;
      }
    }
    if (indices.length) docGeom.attributes.color.needsUpdate = true;
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
