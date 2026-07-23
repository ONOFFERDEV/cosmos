// Chat UI: consumes /ask/stream SSE + renders progress stages/typewriter effect + shows sources/trace.
import { formatOrigin } from './utils.js';

const INSUFFICIENT_TRIGGER = '코퍼스 밖';
const TYPEWRITER_MAX_MS = 2800;

// ---- Small DOM helpers (all dynamic text is inserted via textContent only, no innerHTML) ----

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function displayOrigin(origin) {
  if (typeof origin === 'string' && origin.startsWith('digest://')) {
    return `클러스터 다이제스트: ${origin.slice('digest://'.length)}`;
  }
  return formatOrigin(origin);
}

// ---- Stage labels ----

const STAGE_LABELS = {
  route: (detail) => `클러스터 라우팅${detail ? ` (${detail})` : ''}`,
  search: (detail) => `검색${detail ? ` (${detail})` : ''}`,
  registry: (detail) => `레지스트리 수집${detail ? ` (${detail})` : ''}`,
  digests: (detail) => `다이제스트${detail ? ` (${detail})` : ''}`,
  plan: () => '플래너 계획',
  contradict: () => '모순 검사',
  synthesize: () => '종합 중',
  assemble: () => '조립',
};

function formatStageLabel(stage, detail) {
  if (typeof stage === 'string' && stage.startsWith('agent:')) {
    return `클러스터 협의 — ${stage.slice('agent:'.length)}`;
  }
  const fn = STAGE_LABELS[stage];
  if (fn) return fn(detail);
  return detail ? `${stage} (${detail})` : String(stage);
}

// ---- Auth header + 401 retry ----

// Handles invite links (#token=...): on first visit, auto-saves the token and immediately strips it from the address bar.
// The fragment is never sent to the server, so it doesn't show up in access logs either. (M8 onboarding)
(function adoptInviteToken() {
  const m = /[#&]token=([0-9a-fA-F]{16,})/.exec(window.location.hash);
  if (!m) return;
  localStorage.setItem('cosmos_token', m[1]);
  history.replaceState(null, '', window.location.pathname + window.location.search);
})();

export function authHeaders() {
  const token = localStorage.getItem('cosmos_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ---- My knowledge connector (personal repo connector, M9.6) ----
// The source of truth is each person's own GitHub repo — the server periodically pulls it into my personal space.
// This panel only handles checking connection status, registering the repo, and triggering an immediate sync (zero client-side install).
function setupMyKnowledgeButton() {
  const btn = document.getElementById('my-knowledge-btn');
  if (!btn) return;
  const refresh = () => {
    btn.hidden = !localStorage.getItem('cosmos_token');
  };
  refresh();
  window.addEventListener('cosmos-token-updated', refresh);
  btn.addEventListener('click', toggleRepoPanel);
}

let repoPanelEl = null;

function closeRepoPanel() {
  if (repoPanelEl) {
    repoPanelEl.remove();
    repoPanelEl = null;
  }
}

async function repoApi(method, pathname, body) {
  const res = await fetch(pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

function repoRow(label, value) {
  const row = document.createElement('div');
  row.className = 'repo-row';
  const l = document.createElement('span');
  l.className = 'repo-label';
  l.textContent = label;
  const v = document.createElement('span');
  v.textContent = value;
  row.append(l, v);
  return row;
}

async function toggleRepoPanel() {
  if (repoPanelEl) {
    closeRepoPanel();
    return;
  }
  const panel = document.createElement('div');
  panel.id = 'repo-panel';
  repoPanelEl = panel;

  const head = document.createElement('div');
  head.className = 'repo-head';
  const title = document.createElement('strong');
  title.textContent = '📝 내 지식 레포';
  const close = document.createElement('button');
  close.className = 'panel-close';
  close.textContent = '✕';
  close.addEventListener('click', closeRepoPanel);
  head.append(title, close);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'repo-body';
  bodyEl.textContent = '상태 확인 중…';
  panel.append(head, bodyEl);
  document.body.appendChild(panel);

  const render = async () => {
    const { json } = await repoApi('GET', '/my/repo');
    bodyEl.textContent = '';

    if (json.connected) {
      const r = json.repo;
      bodyEl.appendChild(repoRow('레포', r.repo + (r.branch ? ` (${r.branch})` : '')));
      bodyEl.appendChild(repoRow('마지막 동기화', r.last_synced ? new Date(r.last_synced).toLocaleString() : '아직'));
      if (typeof r.last_ingested === 'number') bodyEl.appendChild(repoRow('반영 문서', `${r.last_ingested}건`));
      if (r.last_error) {
        const err = repoRow('오류', r.last_error);
        err.classList.add('repo-error');
        bodyEl.appendChild(err);
      }
      const hint = document.createElement('p');
      hint.className = 'repo-hint';
      hint.textContent = '레포에 .md를 쓰면(웹·옵시디언 어디서든 push) 1시간 내 자동 반영됩니다 — 나에게만 보여요.';
      bodyEl.appendChild(hint);
    } else {
      const hint = document.createElement('p');
      hint.className = 'repo-hint';
      hint.textContent = '내 GitHub 레포(.md 노트)를 연결하면 push할 때마다 코스모스 내 개인 공간에 자동 반영됩니다. 레포가 없으면 관리자에게 "지식 레포 만들어줘"라고 요청하세요.';
      bodyEl.appendChild(hint);
    }

    const repoInput = document.createElement('input');
    repoInput.placeholder = 'owner/repo (예: our-org/knowledge-철수)';
    repoInput.value = json.connected ? json.repo.repo : '';
    const tokenInput = document.createElement('input');
    tokenInput.placeholder = '개인 레포 토큰(선택 — 회사 org 레포는 비워두세요)';
    tokenInput.type = 'password';

    const actions = document.createElement('div');
    actions.className = 'repo-actions';
    const saveBtn = document.createElement('button');
    saveBtn.textContent = json.connected ? '레포 변경' : '연결';
    saveBtn.addEventListener('click', async () => {
      const repo = repoInput.value.trim();
      if (!repo) return;
      saveBtn.disabled = true;
      saveBtn.textContent = '연결 중…';
      const put = await repoApi('PUT', '/my/repo', {
        repo,
        ...(tokenInput.value.trim() ? { token: tokenInput.value.trim() } : {}),
      });
      saveBtn.disabled = false;
      if (put.status !== 200) {
        alert(put.json.message ?? '등록 실패');
        saveBtn.textContent = '연결';
        return;
      }
      await render();
    });
    actions.appendChild(saveBtn);

    if (json.connected) {
      const syncBtn = document.createElement('button');
      syncBtn.textContent = '지금 동기화';
      syncBtn.addEventListener('click', async () => {
        syncBtn.disabled = true;
        syncBtn.textContent = '동기화 중…';
        const r = await repoApi('POST', '/my/repo/sync');
        syncBtn.disabled = false;
        syncBtn.textContent = r.status === 200
          ? (r.json.changed ? `완료 — ${r.json.ingested}건 반영` : '변경 없음')
          : '실패';
        setTimeout(() => { void render(); }, 1500);
      });
      actions.appendChild(syncBtn);
    }

    bodyEl.append(repoInput, tokenInput, actions);
  };

  await render();
}

async function retryWithPromptedToken(doFetch) {
  const token = window.prompt('인증이 필요합니다. 토큰을 입력해 주세요.');
  if (!token) return null;
  localStorage.setItem('cosmos_token', token);
  // If it's an admin token, notify so the admin console (review.js) appears immediately without a reload (M8.6).
  window.dispatchEvent(new CustomEvent('cosmos-token-updated'));
  try {
    return await doFetch();
  } catch {
    return null;
  }
}

// ---- Request mode mapping (AUTO=field omitted, FAST="point", DEEP="deep") ----

function requestModeField(uiMode) {
  if (uiMode === 'fast') return 'point';
  if (uiMode === 'deep') return 'deep';
  return undefined;
}

// ---- SSE streaming path ----

async function openStreamResponse(question, modeField) {
  const body = { question };
  if (modeField) body.mode = modeField;
  const doFetch = () =>
    fetch('/ask/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    });

  let res;
  try {
    res = await doFetch();
  } catch (err) {
    const e = new Error(`연결 실패: ${err.message ?? err}`);
    e.kind = 'transport';
    throw e;
  }

  if (res.status === 401) {
    res = await retryWithPromptedToken(doFetch);
    if (!res || !res.ok) {
      const e = new Error('인증에 실패했습니다.');
      e.kind = 'transport';
      throw e;
    }
  }

  if (!res.ok || !res.body) {
    const e = new Error(`서버 오류 (HTTP ${res.status})`);
    e.kind = 'transport';
    throw e;
  }
  return res;
}

async function streamAsk(question, modeField, { onStage } = {}) {
  const res = await openStreamResponse(question, modeField);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let envelope = null;
  let serverError = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (block.startsWith(':')) continue;
      const ev = /event: (\S+)/.exec(block)?.[1];
      const dataLine = /data: (.*)/.exec(block)?.[1] ?? '';
      if (ev === 'status') {
        try {
          const payload = JSON.parse(dataLine);
          onStage?.(payload.stage, payload.detail);
        } catch {
          // A malformed status frame just skips the progress display update.
        }
      } else if (ev === 'envelope') {
        try {
          envelope = JSON.parse(dataLine);
        } catch (err) {
          serverError = `응답 해석 실패: ${err.message ?? err}`;
        }
      } else if (ev === 'error') {
        try {
          const payload = JSON.parse(dataLine);
          serverError = payload.message ?? payload.error ?? dataLine;
        } catch {
          serverError = dataLine || '서버에서 오류를 반환했습니다.';
        }
      }
    }
  }

  if (envelope) return envelope;
  const e = new Error(serverError ?? '스트림이 응답 없이 종료되었습니다.');
  e.kind = 'server';
  throw e;
}

// ---- Non-streaming fallback path (/ask) ----

async function postAskPlain(question, modeField) {
  const body = { question };
  if (modeField) body.mode = modeField;
  const doFetch = () =>
    fetch('/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    });

  let res;
  try {
    res = await doFetch();
  } catch (err) {
    throw new Error(`연결 실패: ${err.message ?? err}`);
  }

  if (res.status === 401) {
    res = await retryWithPromptedToken(doFetch);
    if (!res || !res.ok) throw new Error('인증에 실패했습니다.');
  }

  if (!res.ok) throw new Error(`서버 오류 (HTTP ${res.status})`);
  return res.json();
}

// ---- Fixture mode (?fixture=1) — self-contained simulation, no server needed ----

function buildFixtureEnvelope(question, uiMode) {
  const insufficient = question.includes(INSUFFICIENT_TRIGGER);
  const modeField = requestModeField(uiMode);
  const envelopeMode = modeField === 'deep' ? 'deep' : modeField === 'point' ? 'fast' : 'global';

  if (insufficient) {
    return {
      answer: '코퍼스에서 관련 근거를 찾지 못했습니다.',
      sentences: [],
      sources: [],
      trace: [],
      insufficient: true,
      mode: envelopeMode,
      cost: null,
    };
  }

  return {
    answer: `"${question}"에 대한 예시 응답입니다. fixture 모드에서는 실제 코스모스 데이터 대신 샘플 데이터를 사용합니다.`,
    sentences: [
      { text: `"${question}"에 대한 예시 응답입니다.`, citations: [1] },
      { text: 'fixture 모드에서는 실제 코스모스 데이터 대신 샘플 데이터를 사용합니다.', citations: [], uncited: true },
    ],
    sources: [
      { title: '예시 문서 A', origin: 'digest://sample-cluster' },
      { title: '예시 문서 B', origin: 'https://example.com/doc-b' },
    ],
    trace: [
      { cluster: 'sample-cluster', consulted: true, why: '질문과 직접 관련' },
      { cluster: 'other-cluster', consulted: false, why: '임계값 미만' },
    ],
    insufficient: false,
    mode: envelopeMode,
    cost: null,
  };
}

async function fixtureFlow(question, uiMode, { onStage } = {}) {
  const stages = [
    ['route', 'sample-cluster'],
    ['search', '청크 3'],
    ['synthesize', undefined],
    ['assemble', undefined],
  ];
  for (const [stage, detail] of stages) {
    onStage?.(stage, detail);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 220));
  }
  return buildFixtureEnvelope(question, uiMode);
}

// ---- Progress stage list management ----

function setStageState(row, state) {
  row.classList.remove('stage-active', 'stage-done');
  row.classList.add(state === 'done' ? 'stage-done' : 'stage-active');
  const icon = row.querySelector('.stage-icon');
  icon.textContent = '';
  if (state === 'done') {
    icon.textContent = '✓';
  } else {
    icon.appendChild(el('span', 'mini-spinner'));
  }
}

function createStageManager(listEl) {
  const rows = new Map();
  const order = [];

  function upsert(stage, detail) {
    order.forEach((s) => {
      if (s !== stage) setStageState(rows.get(s), 'done');
    });
    let row = rows.get(stage);
    if (!row) {
      row = document.createElement('div');
      row.className = 'stage-row';
      row.appendChild(el('span', 'stage-icon'));
      row.appendChild(el('span', 'stage-label'));
      listEl.appendChild(row);
      rows.set(stage, row);
      order.push(stage);
    }
    row.querySelector('.stage-label').textContent = formatStageLabel(stage, detail);
    setStageState(row, 'active');
  }

  function finishAll() {
    order.forEach((s) => setStageState(rows.get(s), 'done'));
  }

  return { upsert, finishAll };
}

// ---- Elapsed time timer ----

function startElapsedTimer(timerEl) {
  const t0 = Date.now();
  timerEl.textContent = '0.0s';
  const id = setInterval(() => {
    timerEl.textContent = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  }, 100);
  return () => clearInterval(id);
}

// ---- Typewriter effect (guaranteed to finish within TYPEWRITER_MAX_MS) ----

function typewriter(container, text) {
  return new Promise((resolve) => {
    container.textContent = '';
    const total = text.length;
    if (total === 0) {
      resolve();
      return;
    }
    const t0 = performance.now();
    function frame(now) {
      const ratio = Math.min(1, (now - t0) / TYPEWRITER_MAX_MS);
      container.textContent = text.slice(0, Math.ceil(total * ratio));
      if (ratio >= 1) {
        resolve();
        return;
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
}

function renderAnswerWithCitations(container, envelope) {
  container.textContent = '';
  const sentences = Array.isArray(envelope.sentences) ? envelope.sentences : null;
  if (!sentences || sentences.length === 0) {
    container.textContent = envelope.answer ?? '';
    return;
  }
  sentences.forEach((s, i) => {
    const text = typeof s === 'string' ? s : s?.text ?? '';
    if (!text) return;
    if (i > 0) container.appendChild(document.createTextNode(' '));
    container.appendChild(document.createTextNode(text));
    const citations = Array.isArray(s?.citations) ? s.citations : Array.isArray(s?.cites) ? s.cites : null;
    if (citations && citations.length > 0) {
      citations.forEach((n) => container.appendChild(el('sup', 'citation-mark', String(n))));
    } else if (s && typeof s === 'object' && (s.uncited === true || s.cited === false)) {
      container.appendChild(el('span', 'uncited-tag', '미인용'));
    }
  });
}

// ---- Renders the mode badge / sources / trace ----

function buildModeBadge(envelope) {
  if (envelope.insufficient) {
    return el('span', 'mode-badge mode-badge-insufficient', '불충분');
  }
  const map = {
    fast: ['mode-badge-fast', 'FAST'],
    global: ['mode-badge-global', 'GLOBAL'],
    deep: ['mode-badge-deep', 'DEEP'],
  };
  const [cls, label] = map[envelope.mode] ?? ['mode-badge-fast', String(envelope.mode ?? '?').toUpperCase()];
  return el('span', `mode-badge ${cls}`, label);
}

function buildSourcesBlock(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return null;
  const wrap = document.createElement('div');
  wrap.appendChild(el('div', 'chat-subhead', '출처'));
  const list = document.createElement('div');
  list.className = 'source-list';
  sources.forEach((src, i) => {
    const item = document.createElement('div');
    item.className = 'source-item';
    item.appendChild(el('span', 'source-n', `[${i + 1}]`));
    item.appendChild(el('span', 'source-title', src?.title ?? src?.name ?? '(제목 없음)'));
    item.appendChild(el('span', 'source-origin', displayOrigin(src?.origin ?? '')));
    list.appendChild(item);
  });
  wrap.appendChild(list);
  return wrap;
}

function buildTraceDetails(trace) {
  if (!Array.isArray(trace) || trace.length === 0) return null;
  const details = document.createElement('details');
  details.className = 'trace-details';
  details.appendChild(el('summary', undefined, `클러스터 근거 보기 (${trace.length})`));
  const list = document.createElement('div');
  list.className = 'trace-list';
  trace.forEach((t) => {
    const consulted = t?.action ? t.action === 'consulted' : Boolean(t?.consulted);
    const row = document.createElement('div');
    row.className = `trace-row ${consulted ? 'trace-consulted' : 'trace-skipped'}`;
    row.appendChild(el('span', 'trace-cluster', t?.cluster ?? t?.slug ?? t?.name ?? '?'));
    row.appendChild(el('span', 'trace-why', t?.why ?? ''));
    list.appendChild(row);
  });
  details.appendChild(list);
  return details;
}

async function renderFinalAnswer(bubble, envelope) {
  bubble.textContent = '';
  bubble.classList.remove('chat-bubble-insufficient', 'chat-bubble-error');
  if (envelope.insufficient) bubble.classList.add('chat-bubble-insufficient');

  const answerEl = document.createElement('div');
  answerEl.className = 'chat-answer-typing answer-text';
  bubble.appendChild(answerEl);

  await typewriter(answerEl, envelope.answer ?? '');
  renderAnswerWithCitations(answerEl, envelope);

  const meta = document.createElement('div');
  meta.className = 'chat-msg-meta';
  meta.appendChild(buildModeBadge(envelope));
  bubble.insertBefore(meta, answerEl);

  const sourcesBlock = buildSourcesBlock(envelope.sources);
  if (sourcesBlock) bubble.appendChild(sourcesBlock);

  const traceBlock = buildTraceDetails(envelope.trace);
  if (traceBlock) bubble.appendChild(traceBlock);
}

function renderErrorBubble(bubble, message) {
  bubble.textContent = '';
  bubble.classList.add('chat-bubble-error');
  bubble.appendChild(el('div', 'answer-text', message));
}

// ---- Message DOM assembly ----

function appendUserMessage(threadEl, text) {
  const msg = document.createElement('div');
  msg.className = 'chat-msg chat-msg-user';
  msg.appendChild(el('div', 'chat-bubble chat-bubble-user', text));
  threadEl.appendChild(msg);
}

function appendPendingCosmosMessage(threadEl) {
  const msg = document.createElement('div');
  msg.className = 'chat-msg chat-msg-cosmos';
  msg.appendChild(el('div', 'chat-avatar', 'C'));
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble chat-bubble-cosmos';
  const stageList = document.createElement('div');
  stageList.className = 'stage-list';
  bubble.appendChild(stageList);
  const timer = el('div', 'stage-timer', '0.0s');
  bubble.appendChild(timer);
  msg.appendChild(bubble);
  threadEl.appendChild(msg);
  return { bubble, stageList, timer };
}

// ---- Request orchestration (SSE → falls back to /ask on failure; fixture mode uses a separate path) ----

async function askFlow({ question, uiMode, isFixtureMode, stageManager, timerEl }) {
  const stopTimer = startElapsedTimer(timerEl);
  const onStage = (stage, detail) => stageManager.upsert(stage, detail);
  try {
    if (isFixtureMode) {
      const envelope = await fixtureFlow(question, uiMode, { onStage });
      stageManager.finishAll();
      return { ok: true, envelope };
    }

    const modeField = requestModeField(uiMode);
    try {
      const envelope = await streamAsk(question, modeField, { onStage });
      stageManager.finishAll();
      return { ok: true, envelope };
    } catch (err) {
      if (err.kind !== 'transport') {
        stageManager.finishAll();
        return { ok: false, message: err.message ?? String(err) };
      }
      const envelope = await postAskPlain(question, modeField);
      stageManager.finishAll();
      return { ok: true, envelope };
    }
  } catch (err) {
    stageManager.finishAll();
    return { ok: false, message: err.message ?? String(err) };
  } finally {
    stopTimer();
  }
}

// ---- Public entry point ----

export function setupAsk({ els, isFixtureMode }) {
  let currentMode = 'auto';
  let busy = false;
  setupMyKnowledgeButton();

  function setBusy(next) {
    busy = next;
    els.askSubmitBtn.disabled = next;
    els.questionInput.disabled = next;
  }

  function scrollToBottom() {
    els.chatThread.scrollTop = els.chatThread.scrollHeight;
  }

  async function submit() {
    if (busy) return;
    const question = els.questionInput.value.trim();
    if (!question) return;

    setBusy(true);
    els.chatPanel.classList.add('has-messages');
    appendUserMessage(els.chatThread, question);
    els.questionInput.value = '';
    scrollToBottom();

    const pending = appendPendingCosmosMessage(els.chatThread);
    scrollToBottom();
    const stageManager = createStageManager(pending.stageList);

    const result = await askFlow({
      question,
      uiMode: currentMode,
      isFixtureMode,
      stageManager,
      timerEl: pending.timer,
    });

    if (result.ok) {
      await renderFinalAnswer(pending.bubble, result.envelope);
    } else {
      renderErrorBubble(pending.bubble, result.message);
    }
    scrollToBottom();
    setBusy(false);
  }

  els.askSubmitBtn.addEventListener('click', submit);
  els.questionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  els.modeToggle.querySelectorAll('button[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentMode = btn.dataset.mode;
      els.modeToggle.querySelectorAll('button[data-mode]').forEach((b) => b.classList.toggle('active', b === btn));
    });
  });

  els.chatCollapseBtn.addEventListener('click', () => {
    const collapsed = els.chatPanel.classList.toggle('collapsed');
    els.chatCollapseBtn.setAttribute('aria-expanded', String(!collapsed));
  });

  return { submit };
}
