const ROW_INSET_PX = 8;
// j/k inside a block taller than the viewport scroll it by at most this share of the viewport.
const LONG_ROW_STEP = 0.8;

export function findTimelineRow(container: HTMLElement, rowId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-history-row-id="${CSS.escape(rowId)}"]`);
}

export function isTimelineRowVisible(container: HTMLElement, row: HTMLElement): boolean {
  const view = container.getBoundingClientRect();
  const rect = row.getBoundingClientRect();
  return rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom;
}

/** Scrolls the least distance that shows the row, or its top when it is taller than the view. */
export function scrollTimelineRowIntoView(container: HTMLElement, row: HTMLElement): boolean {
  const view = container.getBoundingClientRect();
  const rect = row.getBoundingClientRect();
  const top = view.top + ROW_INSET_PX;
  const bottom = view.bottom - ROW_INSET_PX;
  if (rect.top >= top && rect.bottom <= bottom) return true;
  const alignTop = rect.top < top || rect.height > bottom - top;
  const delta = alignTop ? rect.top - top : rect.bottom - bottom;
  container.scrollTop += delta;
  return Math.abs(delta) < 1;
}

/** Scrolls on through a row that continues past the view in `direction`; false when none is left. */
export function scrollWithinTimelineRow(
  container: HTMLElement,
  row: HTMLElement,
  direction: 1 | -1,
): boolean {
  const view = container.getBoundingClientRect();
  const rect = row.getBoundingClientRect();
  const hidden = direction > 0 ? rect.bottom - view.bottom : view.top - rect.top;
  if (hidden < 1 || !isTimelineRowVisible(container, row)) return false;
  const before = container.scrollTop;
  container.scrollTop += direction * Math.min(hidden + ROW_INSET_PX, view.height * LONG_ROW_STEP);
  return container.scrollTop !== before;
}

/** The bottom-most row that is fully on screen, else the bottom-most one partly on screen. */
export function bottomVisibleTimelineRowId(container: HTMLElement): string | null {
  const view = container.getBoundingClientRect();
  let full: string | null = null;
  let partial: string | null = null;
  for (const row of container.querySelectorAll<HTMLElement>("[data-history-row-id]")) {
    const rowId = row.dataset.historyRowId;
    if (!rowId || !isTimelineRowVisible(container, row)) continue;
    partial = rowId;
    const rect = row.getBoundingClientRect();
    if (rect.top >= view.top && rect.bottom <= view.bottom) full = rowId;
  }
  return full ?? partial;
}

/** The composer of the pane (or Explorer) the timeline sits in. */
export function findTimelineComposerInput(container: HTMLElement): HTMLElement | null {
  const host = container.closest("[data-focus-region='pane'], [data-focus-region='explorer']");
  return host?.querySelector<HTMLElement>("[data-focus-region='composer'] textarea") ?? null;
}
