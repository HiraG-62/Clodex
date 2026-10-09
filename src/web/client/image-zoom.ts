// 画像のビューアの拡大縮小の計算（DESIGN.md §28 成果物）。
// ブラウザ側にそのまま埋め込むため、外部のものを参照しない関数として書く
export interface ZoomView {
  scale: number;
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}

// 枠に収まる倍率（等倍より大きくはしない）で中央に置く
export function fitView(image: Size, stage: Size): ZoomView {
  const scale = Math.min(1, stage.width / image.width, stage.height / image.height);
  return { scale, x: (stage.width - image.width * scale) / 2, y: (stage.height - image.height * scale) / 2 };
}

// point（枠の中の座標）の下にある画像の位置を動かさずに倍率を factor 倍する
export function zoomView(view: ZoomView, factor: number, point: { x: number; y: number }): ZoomView {
  const MIN_SCALE = 0.1;
  const MAX_SCALE = 8;
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
  const ratio = scale / view.scale;
  return { scale, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio };
}
