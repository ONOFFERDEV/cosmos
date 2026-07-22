// 엔트리 포인트: 데이터 로드 -> scene/interactions/ask 모듈 부트스트랩.
import { createUniverseScene } from './scene.js';
import { setupInteractions } from './interactions.js';
import { setupAsk, authHeaders } from './ask.js';
import { hexToCss } from './utils.js';

const params = new URLSearchParams(location.search);
const isFixtureMode = params.get('fixture') === '1';
const dataUrl = isFixtureMode ? '/web/dev-fixture.json' : '/universe';

const els = {
  canvasMount: document.getElementById('universe-canvas-mount'),
  labelLayer: document.getElementById('label-layer'),
  legendStats: document.getElementById('legend-stats'),
  resetViewBtn: document.getElementById('reset-view-btn'),
  tooltip: document.getElementById('tooltip'),
  panel: document.getElementById('detail-panel'),
  panelKind: document.getElementById('panel-kind'),
  panelTitle: document.getElementById('panel-title'),
  panelBody: document.getElementById('panel-body'),
  panelCloseBtn: document.getElementById('panel-close-btn'),
  modeToggle: document.getElementById('mode-toggle'),
  questionInput: document.getElementById('question-input'),
  askSubmitBtn: document.getElementById('ask-submit'),
  chatPanel: document.getElementById('chat-panel'),
  chatThread: document.getElementById('chat-thread'),
  chatCollapseBtn: document.getElementById('chat-collapse-btn'),
  loadingOverlay: document.getElementById('loading-overlay'),
  loadingText: document.getElementById('loading-text'),
  errorOverlay: document.getElementById('error-overlay'),
  errorText: document.getElementById('error-text'),
};

function networkErrorMessage(err) {
  if (location.protocol === 'file:') {
    return 'file:// 로 직접 연 페이지에서는 코스모스 데이터를 불러올 수 없습니다. mind 서버를 통해 (예: http://localhost:8800) 접속해 주세요.';
  }
  return `mind 서버(${location.origin})에 연결할 수 없습니다. 서버가 실행 중인지 확인해 주세요. (${err.message ?? err})`;
}

async function loadUniverse() {
  let res;
  try {
    // M9: 토큰이 있으면 본인 스코프(공통+개인)로 코스모스를 받는다 — 헤더가
    // 빠지면 admin이어도 무인증(공통만) 뷰가 되는 것이 실사용에서 확인된 구멍.
    res = await fetch(dataUrl, { headers: authHeaders() });
  } catch (err) {
    throw new Error(networkErrorMessage(err));
  }
  if (!res.ok) {
    throw new Error(`서버가 오류를 반환했습니다 (HTTP ${res.status}). mind 서버 로그를 확인해 주세요.`);
  }
  try {
    return await res.json();
  } catch (err) {
    throw new Error(`서버 응답을 해석할 수 없습니다 (JSON 파싱 실패). (${err.message ?? err})`);
  }
}

function showError(message) {
  els.loadingOverlay.hidden = true;
  els.errorText.textContent = message;
  els.errorOverlay.hidden = false;
}

function populateLegendStats(data) {
  els.legendStats.textContent = `클러스터 ${data.clusters.length}개 · 문서 ${data.docs.length}개`;
}

// ---- 클러스터 동작 잠금(좌상단 체크박스) ----
// 체크 = 동작, 해제 = 잠금(그 자리 정지). 잠근 목록은 localStorage에 남아
// 새로고침 후에도 유지된다(코퍼스에 없는 슬러그는 무시).
const MOTION_LOCKS_KEY = 'cosmos-motion-locks';

function loadMotionLocks() {
  try {
    const raw = JSON.parse(localStorage.getItem(MOTION_LOCKS_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((s) => typeof s === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveMotionLocks(locked) {
  try {
    localStorage.setItem(MOTION_LOCKS_KEY, JSON.stringify([...locked]));
  } catch {
    /* 저장 실패는 치명적이지 않다(프라이빗 모드 등) */
  }
}

function setupMotionControls(sceneApi) {
  const listEl = document.getElementById('motion-list');
  const allEl = document.getElementById('motion-all');
  if (!listEl || !allEl) return;

  const locked = loadMotionLocks();
  const rows = [];
  const groupHeads = []; // { checkbox, rows } — 섹션(개인/공용) 일괄 토글

  function syncCheckbox(checkboxEl, groupRows) {
    const on = groupRows.filter((r) => r.checkbox.checked).length;
    checkboxEl.checked = on === groupRows.length;
    checkboxEl.indeterminate = on > 0 && on < groupRows.length;
  }

  function syncHeads() {
    syncCheckbox(allEl, rows);
    for (const head of groupHeads) syncCheckbox(head.checkbox, head.rows);
  }

  function applyRow(row, enabled) {
    row.checkbox.checked = enabled;
    row.rowEl.classList.toggle('motion-row-off', !enabled); // 목록 행도 회색으로
    sceneApi.setClusterMotion(row.slug, enabled);
    sceneApi.setClusterLight(row.slug, enabled); // 잠금 = 정지 + 회색 소등
    if (enabled) locked.delete(row.slug);
    else locked.add(row.slug);
  }

  function buildRow(entry) {
    const label = document.createElement('label');
    label.className = 'motion-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';

    const dot = document.createElement('span');
    dot.className = 'motion-dot';
    dot.style.color = hexToCss(entry.color);
    dot.style.background = hexToCss(entry.color);

    const name = document.createElement('span');
    name.className = 'motion-name';
    // 섹션으로 이미 구분되므로 목록 안에선 "개인 · " 접두를 뺀다(3D 라벨은 유지).
    name.textContent = entry.data.name ?? entry.slug;
    name.title = name.textContent;

    label.append(checkbox, dot, name);

    const row = { slug: entry.slug, checkbox, rowEl: label };
    rows.push(row);
    applyRow(row, !locked.has(entry.slug));

    checkbox.addEventListener('change', () => {
      applyRow(row, checkbox.checked);
      saveMotionLocks(locked);
      syncHeads();
    });
    return label;
  }

  function buildGroup(title, entries) {
    if (!entries.length) return;
    const startIdx = rows.length;

    const head = document.createElement('label');
    head.className = 'motion-row motion-group-head';
    const headCheckbox = document.createElement('input');
    headCheckbox.type = 'checkbox';
    const headName = document.createElement('span');
    headName.className = 'motion-name';
    headName.textContent = `${title} (${entries.length})`;
    head.append(headCheckbox, headName);
    listEl.appendChild(head);

    const rowEls = entries.map((entry) => buildRow(entry));
    rowEls.forEach((el) => listEl.appendChild(el));
    const groupRows = rows.slice(startIdx);
    groupHeads.push({ checkbox: headCheckbox, rows: groupRows });

    headCheckbox.addEventListener('change', () => {
      for (const row of groupRows) applyRow(row, headCheckbox.checked);
      saveMotionLocks(locked);
      syncHeads();
    });
  }

  const personal = sceneApi.clusterEntries.filter((e) => e.data.owner);
  const shared = sceneApi.clusterEntries.filter((e) => !e.data.owner);
  buildGroup('개인용', personal);
  buildGroup('공용', shared);

  allEl.addEventListener('change', () => {
    for (const row of rows) applyRow(row, allEl.checked);
    saveMotionLocks(locked);
    syncHeads();
  });

  // 주의: 지금 화면에 없는 슬러그도 locked에 남겨둔다 — 무인증 뷰(공통만)에서
  // 로드해도 개인 클러스터의 잠금 설정이 지워지지 않아야 하기 때문.
  syncHeads();
}

// ---- 표시 옵션: 밝기 슬라이더 ----
// CSS filter로 캔버스 전체(성운·별·문서점)를 균일 조광 — 라벨 레이어는
// 별도 DOM이라 텍스트 가독성은 유지된다. 값은 localStorage에 저장.
const BRIGHTNESS_KEY = 'cosmos-brightness';

function setupDisplayOptions(sceneApi) {
  const slider = document.getElementById('brightness-slider');
  const valueEl = document.getElementById('brightness-value');
  if (!slider || !valueEl) return;

  function apply(percent) {
    const p = Math.min(150, Math.max(30, Number(percent) || 100));
    sceneApi.renderer.domElement.style.filter = p === 100 ? '' : `brightness(${p / 100})`;
    valueEl.textContent = `밝기 ${p}%`;
    slider.value = String(p);
    return p;
  }

  let saved = 100;
  try {
    saved = Number(localStorage.getItem(BRIGHTNESS_KEY)) || 100;
  } catch { /* 접근 불가 시 기본값 */ }
  apply(saved);

  slider.addEventListener('input', () => {
    const p = apply(slider.value);
    try {
      localStorage.setItem(BRIGHTNESS_KEY, String(p));
    } catch { /* 저장 실패 무시 */ }
  });
}

async function main() {
  let data;
  try {
    data = await loadUniverse();
  } catch (err) {
    showError(err.message ?? String(err));
    return;
  }

  let sceneApi;
  try {
    sceneApi = createUniverseScene({
      mountEl: els.canvasMount,
      labelMountEl: els.labelLayer,
      data: { clusters: data.clusters ?? [], docs: data.docs ?? [], edges: data.edges ?? [] },
    });
  } catch (err) {
    showError(`3D 장면을 초기화하지 못했습니다. WebGL을 지원하는 브라우저인지 확인해 주세요. (${err.message ?? err})`);
    return;
  }

  setupInteractions({ sceneApi, canvasEl: sceneApi.renderer.domElement, els });
  setupAsk({ sceneApi, els, isFixtureMode });
  setupMotionControls(sceneApi);
  setupDisplayOptions(sceneApi);

  populateLegendStats(data);
  els.resetViewBtn.addEventListener('click', () => sceneApi.resetView());

  els.loadingOverlay.hidden = true;

  // 토큰을 나중에 입력하면(관리 프롬프트 등) 스코프가 넓어져 개인 클러스터가
  // 새로 내려올 수 있다 — 실제로 달라질 때만 새로고침해 채팅 이력 소실을 최소화.
  window.addEventListener('cosmos-token-updated', async () => {
    try {
      const fresh = await loadUniverse();
      if ((fresh.clusters?.length ?? 0) !== (data.clusters?.length ?? 0)) location.reload();
    } catch {
      /* 재조회 실패는 무시 — 다음 수동 새로고침에서 반영된다 */
    }
  });

  if (isFixtureMode) {
    // eslint-disable-next-line no-console
    console.info('[cosmos] fixture 모드 — dev-fixture.json 사용 중. 질문에 "코퍼스 밖"을 포함하면 insufficient 응답을 시험할 수 있습니다.');
    // fixture 전용 테스트 훅 — 헤드리스 검증이 모션 시계 정지를 직접 어서션할 수 있게.
    window.__cosmosSceneApi = sceneApi;
  }
}

main().catch((err) => {
  showError(`초기화 중 예기치 못한 오류가 발생했습니다. (${err.message ?? err})`);
});
