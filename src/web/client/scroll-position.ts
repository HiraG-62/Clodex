export type ScrollPosition = { kind: "bottom" } | { kind: "anchor"; node: Element; top: number; scrollTop: number };

export function restoredScrollTop(position: ScrollPosition, current: { scrollTop: number; scrollHeight: number; anchorTop?: number }): number {
  if (position.kind === "bottom") return current.scrollHeight;
  if (current.anchorTop === undefined) return position.scrollTop;
  return current.scrollTop + current.anchorTop - position.top;
}

export function captureScrollPosition(container: HTMLElement, nearBottomPx: number): ScrollPosition {
  if (container.scrollHeight - container.scrollTop - container.clientHeight < nearBottomPx) return { kind: "bottom" };
  const bounds = container.getBoundingClientRect();
  for (const node of container.children) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom > bounds.top && rect.top < bounds.bottom) {
      return { kind: "anchor", node, top: rect.top, scrollTop: container.scrollTop };
    }
  }
  return { kind: "anchor", node: container, top: bounds.top, scrollTop: container.scrollTop };
}

export function restoreScrollPosition(container: HTMLElement, position: ScrollPosition): void {
  container.scrollTop = restoredScrollTop(position, {
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    anchorTop: position.kind === "anchor" && position.node.isConnected ? position.node.getBoundingClientRect().top : undefined,
  });
}
