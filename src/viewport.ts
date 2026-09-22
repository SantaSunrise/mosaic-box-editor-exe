export type Viewport = { zoom: number; x: number; y: number };
export type Size = { width: number; height: number };
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;

export function fitSize(stage: Size, aspect: number): Size {
  const width = Math.max(1, Math.min(stage.width, stage.height * aspect));
  return { width, height: width / aspect };
}

export function constrainView(
  view: Viewport,
  image: Size,
  stage: Size,
): Viewport {
  const limitX = Math.max(0, (image.width * view.zoom - stage.width) / 2);
  const limitY = Math.max(0, (image.height * view.zoom - stage.height) / 2);
  return {
    zoom: view.zoom,
    x: Math.max(-limitX, Math.min(limitX, view.x)),
    y: Math.max(-limitY, Math.min(limitY, view.y)),
  };
}

// Pointer coordinates are relative to the center of the stage. Preserve the
// image point beneath the pointer, then prevent panning past the image edges.
export function zoomAt(
  view: Viewport,
  zoom: number,
  pointer: { x: number; y: number },
  image: Size,
  stage: Size,
): Viewport {
  const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
  const ratio = nextZoom / view.zoom;
  return constrainView(
    {
      zoom: nextZoom,
      x: pointer.x - (pointer.x - view.x) * ratio,
      y: pointer.y - (pointer.y - view.y) * ratio,
    },
    image,
    stage,
  );
}
