import { useRef } from 'react';

const MIN_VIEWER = 360;
const MIN_WORK = 340;

export default function PaneDivider({ viewerWidth, onWidthChange }: { viewerWidth: number; onWidthChange: (width: number) => void }) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const clamp = (width: number, host: HTMLElement) => {
    const available = host.getBoundingClientRect().width;
    return Math.max(MIN_VIEWER, Math.min(width, Math.max(MIN_VIEWER, available - MIN_WORK)));
  };
  return <div
    className="pane-divider"
    role="separator"
    aria-label="Resize evidence pane"
    aria-orientation="vertical"
    aria-valuemin={MIN_VIEWER}
    aria-valuemax={1000}
    aria-valuenow={Math.round(viewerWidth)}
    tabIndex={0}
    onPointerDown={event => {
      if (event.button !== 0) return;
      start.current = { x: event.clientX, width: viewerWidth };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      if (!start.current) return;
      const host = event.currentTarget.parentElement;
      if (host) onWidthChange(clamp(start.current.width + start.current.x - event.clientX, host));
    }}
    onPointerUp={() => { start.current = null; }}
    onPointerCancel={() => { start.current = null; }}
    onDoubleClick={() => onWidthChange(520)}
    onKeyDown={event => {
      const step = event.shiftKey ? 40 : 16;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return;
      event.preventDefault();
      const host = event.currentTarget.parentElement;
      if (!host) return;
      onWidthChange(clamp(event.key === 'Home' ? 520 : viewerWidth + (event.key === 'ArrowLeft' ? step : -step), host));
    }}
  />;
}
