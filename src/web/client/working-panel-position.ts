const TRIGGER_GAP = 8;
const EDGE_GAP = 12;

export function workingPanelPosition(
  button: Pick<DOMRect, "right" | "bottom">,
  log: Pick<DOMRect, "bottom">,
  viewport: { width: number; height: number },
): { top: number; right: number; bottom: number } {
  return {
    top: Math.round(button.bottom + TRIGGER_GAP),
    right: Math.max(EDGE_GAP, Math.round(viewport.width - button.right)),
    bottom: Math.max(EDGE_GAP, Math.round(viewport.height - log.bottom)),
  };
}
