import { useRef } from 'react';

const MIN = 220;
const MAX = 320;
const DEFAULT = 248;
const clamp = (value: number) => Math.max(MIN, Math.min(MAX, value));

export default function SidebarDivider({ width, onWidthChange }: { width: number; onWidthChange: (width: number) => void }) {
  const start = useRef<{ x: number; width: number } | null>(null);
  return <div
    className="sidebar-divider"
    role="separator"
    aria-label="Resize navigation sidebar"
    aria-orientation="vertical"
    aria-valuemin={MIN}
    aria-valuemax={MAX}
    aria-valuenow={Math.round(width)}
    tabIndex={0}
    onPointerDown={event => {
      if (event.button !== 0) return;
      start.current = { x: event.clientX, width };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => { if (start.current) onWidthChange(clamp(start.current.width + event.clientX - start.current.x)); }}
    onPointerUp={() => { start.current = null; }}
    onPointerCancel={() => { start.current = null; }}
    onDoubleClick={() => onWidthChange(DEFAULT)}
    onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
      event.preventDefault();
      onWidthChange(clamp(event.key === 'Home' ? DEFAULT : width + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 40 : 16)));
    }}
  />;
}
