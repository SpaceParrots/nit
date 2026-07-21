// Right-docked sidebar: running annotation list with type badges, viewport switch,
// scope filter, pick/finish controls, replay "couldn't place" section.
import { div, span, button } from './dom.js';

export function createSidebar(root, state, actions) {
  const el = document.createElement('aside');
  el.className = 'nit-sidebar';
  root.append(el);
  let collapsed = false;
  let expandedId = null;

  function render() {
    el.innerHTML = '';
    el.classList.toggle('nit-sidebar--collapsed', collapsed);
    const toggle = button('nit-collapse', collapsed ? '‹' : '›', () => { collapsed = !collapsed; render(); });
    if (collapsed) {
      el.append(toggle);
      return;
    }

    const head = div('nit-side-head');
    head.append(span('nit-logo', 'nit'), span('nit-mode', state.mode === 'view' ? 'replay' : 'review'), toggle);
    el.append(head);

    const controls = div('nit-controls');
    if (state.mode === 'review') {
      controls.append(button(
        'nit-btn nit-pick' + (state.picking ? ' nit-btn--active' : ''),
        state.picking ? 'Picking… (Esc to stop)' : 'Pick element (Alt)',
        () => actions.setPicking(!state.picking),
      ));
    }
    const vpRow = div('nit-vp');
    for (const m of ['desktop', 'mobile']) {
      vpRow.append(button(
        `nit-btn nit-vp-${m}` + (state.viewportMode === m ? ' nit-btn--active' : ''),
        m === 'desktop' ? 'Desktop' : 'Mobile',
        () => actions.setViewport(m),
      ));
    }
    controls.append(vpRow);
    controls.append(button(
      'nit-btn nit-filter' + (state.showAll ? ' nit-btn--active' : ''),
      state.showAll ? 'Showing: all scopes' : `Showing: general + ${state.viewportMode}`,
      () => actions.setShowAll(!state.showAll),
    ));
    if (state.mode === 'review') {
      controls.append(button('nit-btn nit-finish', 'Finish review', () => actions.finish()));
    }
    el.append(controls);

    const numbering = new Map();
    state.placed.forEach((p, i) => numbering.set(p.ann.id, i + 1));

    const list = div('nit-list');
    for (const ann of state.annotations) list.append(item(ann, numbering.get(ann.id)));
    if (!state.annotations.length) {
      list.append(div('nit-empty', state.mode === 'review'
        ? 'Press Alt, click an element, write what should change.'
        : 'No annotations in this file.'));
    }
    el.append(list);

    if (state.unplaced.length) {
      const cp = div('nit-unplaced');
      cp.append(div('nit-unplaced-head', `Couldn't place on this page (${state.unplaced.length})`));
      for (const ann of state.unplaced) cp.append(item(ann, null, true));
      el.append(cp);
    }
  }

  function item(ann, num, unplaced = false) {
    const it = div(
      'nit-item'
      + (unplaced ? ' nit-item--unplaced' : '')
      + (ann.status !== 'open' ? ' nit-item--closed' : ''),
    );
    it.dataset.id = ann.id;
    const head = div('nit-item-head');
    head.append(
      span('nit-num', num != null ? String(num) : '·'),
      span(`nit-badge nit-badge--${ann.type}`, ann.type === 'change-request' ? 'CR' : 'C'),
      span('nit-item-comment', ann.comment),
    );
    if (state.mode === 'review') {
      head.append(button('nit-del', '×', e => {
        e.stopPropagation();
        actions.del(ann.id);
      }));
    }
    it.append(head);
    it.addEventListener('click', () => {
      expandedId = expandedId === ann.id ? null : ann.id;
      render();
    });

    if (expandedId === ann.id) {
      const meta = div('nit-item-meta');
      meta.append(div('nit-meta-line', `${ann.id} · ${ann.status} · scope ${ann.viewportScope} · ${ann.route}`));
      const t = ann.target || {};
      meta.append(div('nit-meta-line', `component: ${t.component || '?'}${t.ngComponent ? ` (${t.ngComponent})` : ''}`));
      if (ann.screenshot && typeof window.__nitShot === 'function') {
        const img = document.createElement('img');
        img.className = 'nit-shot';
        img.alt = ann.id;
        window.__nitShot(ann.id).then(src => {
          if (src) img.src = src;
          else img.remove();
        }).catch(() => img.remove());
        meta.append(img);
      }
      it.append(meta);
    }
    return it;
  }

  function focus(id) {
    collapsed = false;
    expandedId = id;
    render();
    const node = el.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (node) node.scrollIntoView({ block: 'nearest' });
  }

  return { render, focus };
}
