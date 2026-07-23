// Entry point: load data -> bootstrap scene/interactions/ask modules.
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
    // M9: If a token exists, fetch the cosmos in the caller's own scope (shared+personal) — omitting
    // this header falls back to the unauthenticated (shared-only) view even for admins, a gap confirmed in real usage.
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

// ---- Cluster motion lock (top-left checkboxes) ----
// Checked = moving, unchecked = locked (frozen in place). The locked list is kept in localStorage
// and persists across reloads (slugs not present in the corpus are ignored).
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
    /* save failure isn't fatal (e.g. private browsing mode) */
  }
}

function setupMotionControls(sceneApi) {
  const listEl = document.getElementById('motion-list');
  const allEl = document.getElementById('motion-all');
  if (!listEl || !allEl) return;

  const locked = loadMotionLocks();
  const rows = [];
  const groupHeads = []; // { checkbox, rows } — bulk toggle per section (personal/shared)

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
    // Already distinguished by section, so drop the "개인 · " prefix within the list (the 3D label keeps it).
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

  // Note: slugs not currently on screen are still kept in locked — because loading the
  // unauthenticated view (shared-only) shouldn't wipe out the personal clusters' lock settings.
  syncHeads();
}

// ---- Display options: brightness slider ----
// Uniformly dims the whole canvas (nebula/stars/doc points) via CSS filter — the label layer
// is a separate DOM so text legibility is preserved. Value is stored in localStorage.
const BRIGHTNESS_KEY = 'cosmos-brightness';
const LINKS_KEY = 'cosmos-links'; // M10 relationship-line toggle memory

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
  } catch { /* default value if inaccessible */ }
  apply(saved);

  slider.addEventListener('input', () => {
    const p = apply(slider.value);
    try {
      localStorage.setItem(BRIGHTNESS_KEY, String(p));
    } catch { /* 저장 실패 무시 */ }
  });

  // M10 relationship-line toggle (default on, remembered in localStorage). If there are 0 links, hide the row entirely.
  const linksToggle = document.getElementById('links-toggle');
  const linksCount = document.getElementById('links-count');
  if (linksToggle) {
    if (!sceneApi.linkCount) {
      const row = linksToggle.closest('label');
      if (row) row.style.display = 'none';
    } else {
      if (linksCount) linksCount.textContent = `${sceneApi.linkCount}개`;
      let on = false; // default off — only restored from memory for users who explicitly turned it on
      try {
        on = localStorage.getItem(LINKS_KEY) === 'on';
      } catch { /* default off if inaccessible */ }
      linksToggle.checked = on;
      sceneApi.setLinksVisible(on);
      linksToggle.addEventListener('change', () => {
        sceneApi.setLinksVisible(linksToggle.checked);
        try {
          localStorage.setItem(LINKS_KEY, linksToggle.checked ? 'on' : 'off');
        } catch { /* 저장 실패 무시 */ }
      });
    }
  }
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
      data: { clusters: data.clusters ?? [], docs: data.docs ?? [], edges: data.edges ?? [], links: data.links ?? [] },
    });
  } catch (err) {
    showError(`3D 장면을 초기화하지 못했습니다. WebGL을 지원하는 브라우저인지 확인해 주세요. (${err.message ?? err})`);
    return;
  }

  // Attach the returned panel API onto sceneApi so the headless gate (__cosmosSceneApi.interactions) can use it.
  sceneApi.interactions = setupInteractions({ sceneApi, canvasEl: sceneApi.renderer.domElement, els });
  setupAsk({ sceneApi, els, isFixtureMode });
  setupMotionControls(sceneApi);
  setupDisplayOptions(sceneApi);

  populateLegendStats(data);
  els.resetViewBtn.addEventListener('click', () => sceneApi.resetView());

  els.loadingOverlay.hidden = true;

  // If a token is entered later (e.g. via the admin prompt), the scope widens and personal
  // clusters may newly appear — only reload when it actually changed, to minimize loss of chat history.
  window.addEventListener('cosmos-token-updated', async () => {
    try {
      const fresh = await loadUniverse();
      if ((fresh.clusters?.length ?? 0) !== (data.clusters?.length ?? 0)) location.reload();
    } catch {
      /* ignore re-fetch failure — it'll be reflected on the next manual reload */
    }
  });

  if (isFixtureMode) {
    // eslint-disable-next-line no-console
    console.info('[cosmos] fixture 모드 — dev-fixture.json 사용 중. 질문에 "코퍼스 밖"을 포함하면 insufficient 응답을 시험할 수 있습니다.');
    // fixture-only test hook — lets headless verification directly assert that the motion clock stopped.
    window.__cosmosSceneApi = sceneApi;
  }
}

main().catch((err) => {
  showError(`초기화 중 예기치 못한 오류가 발생했습니다. (${err.message ?? err})`);
});
