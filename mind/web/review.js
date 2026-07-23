// Knowledge PR review screen — browse the open-branch list/documents + merge/reject (admin) + overlay preview search.
// Initializes itself independently of app.js (a zero-modification connection). The auth-header/401-retry pattern is reimplemented identically to ask.js.

const POLL_INTERVAL_MS = 60000;

const els = {
  badgeBtn: document.getElementById('review-badge-btn'),
  panel: document.getElementById('review-panel'),
  panelBody: document.getElementById('review-panel-body'),
  panelTitle: document.getElementById('review-panel-title'),
  closeBtn: document.getElementById('review-panel-close-btn'),
};

let role = null;
let branches = [];
let activeBranch = null;
let activeDocs = [];

// ---- Auth header + 401 retry (same pattern as ask.js) ----

function authHeaders() {
  const token = localStorage.getItem('cosmos_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function retryWithPromptedToken(doFetch) {
  const token = window.prompt('인증이 필요합니다. 토큰을 입력해 주세요.');
  if (!token) return null;
  localStorage.setItem('cosmos_token', token);
  try {
    return await doFetch();
  } catch {
    return null;
  }
}

async function apiFetch(path, options = {}) {
  const doFetch = () =>
    fetch(path, { ...options, headers: { ...(options.headers ?? {}), ...authHeaders() } });
  let res = await doFetch();
  if (res.status === 401) {
    res = await retryWithPromptedToken(doFetch);
    if (!res) throw new Error('인증 실패');
  }
  return res;
}

async function fetchJson(path, options) {
  const res = await apiFetch(path, options);
  if (!res.ok) throw new Error(`요청 실패 (HTTP ${res.status})`);
  return res.json();
}

// ---- DOM helpers ----

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text != null) node.textContent = opts.text;
  if (opts.onClick) node.addEventListener('click', opts.onClick);
  for (const child of children) node.appendChild(child);
  return node;
}

function formatDate(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleDateString('ko-KR');
  } catch {
    return String(ts);
  }
}

// ---- Data loading ----

async function loadMe() {
  try {
    const me = await fetchJson('/me');
    role = me.role ?? null;
  } catch {
    role = null;
  }
}

function sumOpenDocs(list) {
  return list.reduce((sum, b) => sum + (b.n_docs ?? 0), 0);
}

async function refreshBadge() {
  try {
    branches = await fetchJson('/branches?status=open');
  } catch {
    branches = [];
  }
  const total = sumOpenDocs(branches);
  // M8.6: this code only initializes for admins. Even with nothing pending review, the invite
  // and other admin entry points are still needed, so the badge is always shown (switches to the "Manage" label).
  els.badgeBtn.hidden = false;
  els.badgeBtn.textContent = total > 0 ? `검토 ${total}` : '관리';
  els.badgeBtn.classList.toggle('review-badge-idle', total === 0);
}

// ---- Branch list ----

function renderBranchList() {
  activeBranch = null;
  clear(els.panelBody);
  els.panelTitle.textContent = '브랜치 선택';

  if (branches.length === 0) {
    els.panelBody.appendChild(el('p', { className: 'review-empty', text: '열린 브랜치가 없습니다.' }));
  } else {
    const list = el('div', { className: 'review-branch-list' });
    for (const b of branches) {
      const item = el(
        'button',
        { className: 'review-branch-item', onClick: () => openBranch(b) },
        [
          el('div', { className: 'review-branch-name', text: b.name }),
          el('div', { className: 'review-branch-meta', text: `문서 ${b.n_docs ?? 0}개 · ${formatDate(b.created_at)}` }),
        ],
      );
      list.appendChild(item);
    }
    els.panelBody.appendChild(list);
  }

  els.panelBody.appendChild(buildInviteSection());
}

// ---- Invite a teammate (admin-only panel — M8.6) ----

function buildInviteSection() {
  const container = el('div', { className: 'review-invite' });
  container.appendChild(el('div', { className: 'review-invite-label', text: '팀원 초대' }));

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'review-invite-input';
  nameInput.placeholder = '이름 입력…';

  const searchBtn = el('button', { className: 'review-invite-btn', text: '검색' });
  const candidatesEl = el('div', { className: 'review-invite-candidates' });
  const sendRowEl = el('div', { className: 'review-invite-send-row' });
  const resultLine = el('div', { className: 'review-invite-result' });

  let selected = null;

  function renderSendRow() {
    clear(sendRowEl);
    if (!selected) return;
    const label = selected.real_name || selected.display_name || selected.id;
    sendRowEl.appendChild(
      el('button', {
        className: 'review-invite-send-btn',
        text: `초대 DM 발송 → ${label}`,
        onClick: () => doInvite(),
      }),
    );
  }

  function renderCandidates(users) {
    clear(candidatesEl);
    if (users.length === 0) {
      candidatesEl.appendChild(el('p', { className: 'review-empty', text: '검색 결과가 없습니다.' }));
      return;
    }
    for (const u of users) {
      const item = el('button', { className: 'review-invite-candidate' }, [
        el('span', { className: 'review-invite-candidate-name', text: u.real_name || u.id }),
        el('span', {
          className: 'review-invite-candidate-display',
          text: u.display_name ? `@${u.display_name}` : '',
        }),
      ]);
      item.addEventListener('click', () => {
        selected = u;
        for (const child of candidatesEl.children) {
          child.classList.toggle('review-invite-candidate-selected', child === item);
        }
        renderSendRow();
      });
      candidatesEl.appendChild(item);
    }
  }

  async function doSearch() {
    const q = nameInput.value.trim();
    if (!q) return;
    selected = null;
    renderSendRow();
    clear(candidatesEl);
    candidatesEl.appendChild(el('p', { className: 'review-loading', text: '검색 중…' }));
    try {
      const users = await fetchJson(`/slack/users?q=${encodeURIComponent(q)}`);
      renderCandidates(users);
    } catch (err) {
      clear(candidatesEl);
      candidatesEl.appendChild(el('p', { className: 'review-error', text: `검색 실패: ${err.message ?? err}` }));
    }
  }

  async function doInvite() {
    if (!selected) return;
    const name = nameInput.value.trim();
    if (!name) return;
    resultLine.textContent = '발송 중…';
    try {
      const result = await fetchJson('/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, slack_user_id: selected.id }),
      });
      resultLine.textContent = result.sent
        ? 'DM 발송됨 — 인증 시 링크 자동 삭제'
        : `수동 전달 필요 — 토큰: ${result.token}`;
      nameInput.value = '';
      selected = null;
      clear(candidatesEl);
      renderSendRow();
    } catch (err) {
      resultLine.textContent = `초대 실패: ${err.message ?? err}`;
    }
  }

  searchBtn.addEventListener('click', doSearch);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });

  const row = el('div', { className: 'review-invite-row' }, [nameInput, searchBtn]);
  container.appendChild(row);
  container.appendChild(candidatesEl);
  container.appendChild(sendRowEl);
  container.appendChild(resultLine);
  return container;
}

// ---- Document table ----

async function openBranch(branch) {
  activeBranch = branch;
  els.panelTitle.textContent = branch.name;
  clear(els.panelBody);
  els.panelBody.appendChild(el('p', { className: 'review-loading', text: '문서 불러오는 중…' }));

  try {
    activeDocs = await fetchJson(`/branches/${branch.id}/docs`);
  } catch (err) {
    clear(els.panelBody);
    els.panelBody.appendChild(
      el('p', { className: 'review-error', text: `문서를 불러오지 못했습니다. (${err.message ?? err})` }),
    );
    return;
  }

  renderDocTable();
}

function sourceBadgeClass(sourceType) {
  return `review-source-badge review-source-${sourceType ?? 'manual'}`;
}

function renderDocTable() {
  clear(els.panelBody);

  els.panelBody.appendChild(
    el('button', { className: 'review-back-btn', text: '← 브랜치 목록', onClick: () => renderBranchList() }),
  );

  const table = el('table', { className: 'review-doc-table' });
  const thead = el('thead', {}, [
    el('tr', {}, [
      el('th', { className: 'review-col-check' }),
      el('th', { text: '제목' }),
      el('th', { text: '출처' }),
      el('th', { text: '클러스터' }),
      el('th', { text: 'fit' }),
    ]),
  ]);
  table.appendChild(thead);

  const tbody = el('tbody');
  for (const doc of activeDocs) {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.dataset.docId = doc.doc_id;

    const fitVal = typeof doc.fit === 'number' ? doc.fit.toFixed(2) : '—';
    const fitClass = typeof doc.fit === 'number' && doc.fit < 0.5 ? 'review-fit-low' : '';

    const row = el('tr', {}, [
      el('td', {}, [checkbox]),
      el('td', { className: 'review-doc-title', text: doc.title ?? '(제목 없음)' }),
      el('td', {}, [el('span', { className: sourceBadgeClass(doc.source_type), text: doc.source_type ?? '—' })]),
      el('td', { className: 'review-doc-cluster', text: doc.cluster_slug ?? '—' }),
      el('td', { className: fitClass, text: fitVal }),
    ]);
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  els.panelBody.appendChild(table);

  if (role === 'admin') {
    const mergeBtn = el('button', { className: 'review-merge-btn', text: `선택 병합 (${activeDocs.length})` });
    const discardBtn = el('button', { className: 'review-discard-btn', text: '브랜치 거부', onClick: () => doDiscard() });
    mergeBtn.addEventListener('click', () => doMerge(mergeBtn, tbody));

    tbody.addEventListener('change', () => {
      const checked = tbody.querySelectorAll('input[type="checkbox"]:checked').length;
      mergeBtn.textContent = `선택 병합 (${checked})`;
      mergeBtn.disabled = checked === 0;
    });

    const actions = el('div', { className: 'review-actions' }, [mergeBtn, discardBtn]);
    els.panelBody.appendChild(actions);
  }

  els.panelBody.appendChild(el('div', { className: 'review-result-line' }));
  els.panelBody.appendChild(renderPreviewSearch());
}

function showResult(text) {
  const line = els.panelBody.querySelector('.review-result-line');
  if (line) line.textContent = text;
}

async function doMerge(mergeBtn, tbody) {
  if (!activeBranch) return;
  const docIds = Array.from(tbody.querySelectorAll('input[type="checkbox"]:checked')).map((cb) => cb.dataset.docId);
  if (docIds.length === 0) return;

  mergeBtn.disabled = true;
  try {
    const result = await fetchJson(`/branches/${activeBranch.id}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc_ids: docIds }),
    });
    const branchRef = activeBranch;
    await refreshBadge();
    showResult(`병합 완료 — merged ${result.merged ?? docIds.length}, remaining ${result.remaining ?? 0}`);
    if ((result.remaining ?? 0) > 0) {
      await openBranch(branchRef);
      showResult(`병합 완료 — merged ${result.merged ?? docIds.length}, remaining ${result.remaining ?? 0}`);
    } else {
      renderBranchList();
    }
  } catch (err) {
    mergeBtn.disabled = false;
    showResult(`병합 실패: ${err.message ?? err}`);
  }
}

async function doDiscard() {
  if (!activeBranch) return;
  const ok = window.confirm('비가역 — 문서가 삭제됩니다');
  if (!ok) return;

  const branchName = activeBranch.name;
  try {
    await apiFetch(`/branches/${activeBranch.id}/discard`, { method: 'POST' });
    await refreshBadge();
    renderBranchList();
    showResult(`브랜치 "${branchName}" 거부됨`);
  } catch (err) {
    showResult(`거부 실패: ${err.message ?? err}`);
  }
}

// ---- Preview search (overlay /search) ----

function renderPreviewSearch() {
  const container = el('div', { className: 'review-preview' });
  container.appendChild(el('div', { className: 'review-preview-label', text: '미리보기 검색 (오버레이)' }));

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'review-preview-input';
  input.placeholder = '질문 입력…';

  const btn = el('button', { className: 'review-preview-btn', text: '검색' });
  const resultsEl = el('div', { className: 'review-preview-results' });

  async function runSearch() {
    const query = input.value.trim();
    if (!query || !activeBranch) return;
    clear(resultsEl);
    resultsEl.appendChild(el('p', { className: 'review-loading', text: '검색 중…' }));
    try {
      const data = await fetchJson('/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, k: 5, include_branch_id: activeBranch.id }),
      });
      renderPreviewResults(resultsEl, data.results ?? []);
    } catch (err) {
      clear(resultsEl);
      resultsEl.appendChild(el('p', { className: 'review-error', text: `검색 실패: ${err.message ?? err}` }));
    }
  }

  btn.addEventListener('click', runSearch);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch();
  });

  const row = el('div', { className: 'review-preview-row' }, [input, btn]);
  container.appendChild(row);
  container.appendChild(resultsEl);
  return container;
}

function renderPreviewResults(resultsEl, results) {
  clear(resultsEl);
  if (results.length === 0) {
    resultsEl.appendChild(el('p', { className: 'review-empty', text: '결과가 없습니다.' }));
    return;
  }

  const branchOrigins = new Set(activeDocs.map((d) => d.origin));
  for (const r of results) {
    const isBranchDoc = branchOrigins.has(r.origin);
    const item = el('div', { className: `review-preview-item${isBranchDoc ? ' review-preview-item-branch' : ''}` });

    const titleRow = el('div', { className: 'review-preview-item-title' });
    titleRow.appendChild(document.createTextNode(r.title ?? r.origin ?? '(제목 없음)'));
    if (isBranchDoc) {
      titleRow.appendChild(el('span', { className: 'review-branch-tag', text: '브랜치' }));
    }
    item.appendChild(titleRow);
    item.appendChild(el('div', { className: 'review-preview-item-snippet', text: r.text ?? '' }));
    resultsEl.appendChild(item);
  }
}

// ---- Panel toggle + initialization ----

function togglePanel(forceOpen) {
  const shouldOpen = forceOpen ?? els.panel.hidden;
  if (shouldOpen) {
    els.panel.hidden = false;
    refreshBadge().then(() => renderBranchList());
  } else {
    els.panel.hidden = true;
  }
}

let initialized = false;

async function init() {
  if (initialized) return;
  if (!els.badgeBtn || !els.panel) return;

  await loadMe();
  if (role !== 'admin') {
    // M8.6: the admin console is admin-only — members never initialize the badge/panel at all (zero admin elements).
    els.badgeBtn.hidden = true;
    return;
  }
  initialized = true;

  await refreshBadge();

  els.badgeBtn.addEventListener('click', () => togglePanel());
  els.closeBtn?.addEventListener('click', () => togglePanel(false));

  setInterval(refreshBadge, POLL_INTERVAL_MS);
}

init().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[cosmos] 검토 패널 초기화 실패', err);
});

// If a new token is entered mid-question (ask.js prompt), the admin console re-evaluates without a reload (M8.6).
window.addEventListener('cosmos-token-updated', () => {
  init().catch(() => {});
});
