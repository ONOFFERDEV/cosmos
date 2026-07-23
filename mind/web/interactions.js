// Pointer hover/click -> tooltip + right-side detail panel. three.js scene construction/render is handled by scene.js.
import { authHeaders } from './ask.js';
import { escapeHtml, formatOrigin, hexToCss } from './utils.js';

const SOURCE_LABEL = { session: '세션 기록', arxiv: 'arXiv 논문', rss: 'RSS 피드', manual: '수동 등록' };

export function setupInteractions({ sceneApi, canvasEl, els }) {
  const { tooltip, panel, panelKind, panelTitle, panelBody, panelCloseBtn } = els;

  const clustersBySlug = new Map(sceneApi.clusterEntries.map((e) => [e.slug, e.data]));
  const clusterColorBySlug = new Map(sceneApi.clusterEntries.map((e) => [e.slug, e.color]));
  const docsByCluster = new Map();
  sceneApi.docs.forEach((d, index) => {
    const list = docsByCluster.get(d.cluster_slug) ?? [];
    list.push({ ...d, index });
    docsByCluster.set(d.cluster_slug, list);
  });

  let hoverPending = false;
  let lastHit = null;

  function hideTooltip() {
    tooltip.classList.remove('visible');
  }

  function showTooltip(clientX, clientY, hit) {
    let html = '';
    if (hit.type === 'cluster') {
      html = `<strong>${escapeHtml(hit.data.owner ? `개인 · ${hit.data.name}` : hit.data.name)}</strong>`;
      const note = hit.object.userData.queryNote;
      if (note) html += `<br><span class="tooltip-note">${escapeHtml(note)}</span>`;
    } else {
      html = `<strong>${escapeHtml(hit.data.title)}</strong><br><span class="tooltip-note">${escapeHtml(SOURCE_LABEL[hit.data.source_type] ?? hit.data.source_type)}</span>`;
    }
    tooltip.innerHTML = html;
    tooltip.style.left = `${clientX + 16}px`;
    tooltip.style.top = `${clientY + 16}px`;
    tooltip.classList.add('visible');
  }

  function onPointerMove(ev) {
    if (hoverPending) return;
    hoverPending = true;
    requestAnimationFrame(() => {
      hoverPending = false;
      const hit = sceneApi.raycastAtClient(ev.clientX, ev.clientY);
      lastHit = hit;
      canvasEl.style.cursor = hit ? 'pointer' : 'grab';
      if (hit) showTooltip(ev.clientX, ev.clientY, hit);
      else hideTooltip();
    });
  }

  function onPointerLeave() {
    hideTooltip();
    lastHit = null;
  }

  function onClick(ev) {
    const hit = sceneApi.raycastAtClient(ev.clientX, ev.clientY);
    if (!hit) return;
    if (hit.type === 'cluster') openClusterPanel(hit.data);
    else openDocPanel(hit.data, hit.index);
  }

  function repFitBar(fit) {
    const pct = Math.round(fit * 100);
    return `<div class="fit-bar"><div class="fit-bar-fill" style="width:${pct}%"></div></div><span class="fit-value">${pct}%</span>`;
  }

  function openClusterPanel(cluster) {
    panelKind.textContent = cluster.owner ? '개인 클러스터' : '클러스터';
    panelTitle.textContent = cluster.owner ? `개인 · ${cluster.name}` : cluster.name;
    const docs = (docsByCluster.get(cluster.slug) ?? []).slice().sort((a, b) => (b.fit ?? 0) - (a.fit ?? 0));
    const top = docs.slice(0, 6);
    const color = hexToCss(clusterColorBySlug.get(cluster.slug) ?? 0xffffff);
    panelBody.innerHTML = `
      <p class="panel-desc">${escapeHtml(cluster.description ?? '')}</p>
      <div class="field-row"><span class="field-label">문서 수</span><span>${cluster.n_docs ?? docs.length}개 · 청크 ${cluster.n_chunks ?? '—'}개</span></div>
      <div class="field-row"><span class="field-label">상태</span><span>${escapeHtml(cluster.status ?? '—')}</span></div>
      ${cluster.owner ? `<div class="field-row"><span class="field-label">소유</span><span>개인 공간 (${escapeHtml(cluster.owner)})</span></div>` : ''}
      <h3 class="panel-subhead" style="--cluster-color:${color}">대표 문서</h3>
      <ul class="doc-list">
        ${top.map((d) => `<li class="doc-list-item" data-doc-index="${d.index}">
          <span class="doc-list-title">${escapeHtml(d.title)}</span>
          <span class="doc-list-meta">${escapeHtml(SOURCE_LABEL[d.source_type] ?? d.source_type)} · ${Math.round((d.fit ?? 0) * 100)}%</span>
        </li>`).join('') || '<li class="doc-list-empty">문서 없음</li>'}
      </ul>
    `;
    panel.classList.add('open');
    panelBody.querySelectorAll('.doc-list-item').forEach((li) => {
      li.addEventListener('click', () => {
        const idx = Number(li.dataset.docIndex);
        const d = sceneApi.docs[idx];
        if (d) openDocPanel(d, idx);
      });
    });
    sceneApi.clearDocHighlight();
    sceneApi.highlightCluster(cluster.slug);
    sceneApi.focusOn(cluster.pos, Math.max(cluster.radius * 4.2, 45));
  }

  function openDocPanel(doc, index) {
    panelKind.textContent = '문서';
    panelTitle.textContent = doc.title;
    const cluster = clustersBySlug.get(doc.cluster_slug);
    panelBody.innerHTML = `
      <div class="field-row"><span class="field-label">출처</span><span>${escapeHtml(SOURCE_LABEL[doc.source_type] ?? doc.source_type)}</span></div>
      <div class="field-row"><span class="field-label">경로</span><span class="mono-small" title="${escapeHtml(doc.origin ?? '')}">${escapeHtml(formatOrigin(doc.origin))}</span></div>
      <div class="field-row"><span class="field-label">적합도</span>${repFitBar(doc.fit ?? 0.55)}</div>
      <div class="field-row"><span class="field-label">클러스터</span><span class="link-like" id="panel-back-to-cluster">${escapeHtml(cluster?.name ?? doc.cluster_slug)}</span></div>
    `;
    panel.classList.add('open');
    const back = panelBody.querySelector('#panel-back-to-cluster');
    if (back && cluster) back.addEventListener('click', () => openClusterPanel(cluster));
    sceneApi.clearClusterHighlight();
    sceneApi.highlightDocByIndex(index);
    // doc.pos is the static coordinate (original fixture) — while orbiting, we must use getDocWorldPos()
    // for the current position so the camera doesn't fly off to an empty old spot (same approach as ask.js's citation-click).
    sceneApi.focusOn(sceneApi.getDocWorldPos(index).toArray(), 26);
    void appendGraphLinks(doc);
  }

  // M10: Asynchronously appends the document's relationships (inbound/outbound) to the bottom of the panel. Silently skipped if the graph is unavailable.
  async function appendGraphLinks(doc) {
    if (!doc.doc_id) return;
    let data;
    try {
      const res = await fetch(`/graph/docs/${encodeURIComponent(doc.doc_id)}`, { headers: authHeaders() });
      if (!res.ok) return;
      data = await res.json();
    } catch {
      return;
    }
    if (panelTitle.textContent !== doc.title) return; // moved to a different panel in the meantime
    const total = (data.outbound?.length ?? 0) + (data.inbound?.length ?? 0);
    if (total === 0) return;

    const wrap = document.createElement('div');
    const head = document.createElement('h3');
    head.className = 'panel-subhead';
    head.textContent = `연결된 지식 (${total})`;
    wrap.appendChild(head);
    const list = document.createElement('ul');
    list.className = 'doc-list';
    const addItem = (item, dirLabel) => {
      const li = document.createElement('li');
      li.className = 'doc-list-item';
      const name = document.createElement('span');
      name.className = 'doc-list-title';
      name.textContent = item.doc?.title ?? item.target_name;
      const meta = document.createElement('span');
      meta.className = 'doc-list-meta';
      meta.textContent = `${dirLabel} · ${item.rel_type}${item.doc ? '' : ' · 코퍼스 밖'}`;
      li.append(name, meta);
      if (item.doc) {
        const idx = sceneApi.docs.findIndex((d) => d.doc_id === item.doc.doc_id);
        if (idx >= 0) {
          li.addEventListener('click', () => openDocPanel(sceneApi.docs[idx], idx));
        }
      }
      list.appendChild(li);
    };
    for (const item of data.outbound ?? []) addItem(item, '나감');
    for (const item of data.inbound ?? []) addItem(item, '들어옴');
    wrap.appendChild(list);
    panelBody.appendChild(wrap);
  }

  function closePanel() {
    panel.classList.remove('open');
    sceneApi.clearDocHighlight();
    sceneApi.clearClusterHighlight();
  }

  canvasEl.addEventListener('pointermove', onPointerMove);
  canvasEl.addEventListener('pointerleave', onPointerLeave);
  canvasEl.addEventListener('click', onClick);
  panelCloseBtn.addEventListener('click', closePanel);

  return {
    openClusterPanel,
    openDocPanel,
    closePanel,
    dispose() {
      canvasEl.removeEventListener('pointermove', onPointerMove);
      canvasEl.removeEventListener('pointerleave', onPointerLeave);
      canvasEl.removeEventListener('click', onClick);
    },
  };
}
