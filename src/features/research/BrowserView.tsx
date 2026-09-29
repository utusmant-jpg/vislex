import { useRef, useState, type ReactNode } from 'react';
import BrowserPane from './BrowserPane';
import './research.css';

export const BROWSER_WIDTH_KEY = 'vislex.research.browserWidth';
const DEFAULT_WIDTH = 640;
const MIN_BROWSER = 360;
const MIN_CHAT = 340;

function savedWidth(): number {
  try {
    const value = Number(window.localStorage.getItem(BROWSER_WIDTH_KEY));
    return Number.isFinite(value) && value >= MIN_BROWSER ? value : DEFAULT_WIDTH;
  } catch { return DEFAULT_WIDTH; }
}
function saveWidth(width: number) {
  try { window.localStorage.setItem(BROWSER_WIDTH_KEY, String(Math.round(width))); } catch { /* Width is a per-device convenience only. */ }
}

/**
 * Split view: the case chat on the left and the research browser on the right,
 * separated by a draggable, keyboard-operable divider. The browser width is a
 * per-device preference.
 */
export default function BrowserView({ chat, caseId, sessionEpoch, offline, suspended, onOpenSettings }: {
  chat: ReactNode;
  caseId: string;
  sessionEpoch?: number;
  offline?: boolean;
  suspended?: boolean;
  onOpenSettings: (section: 'Research browser' | 'Privacy & offline') => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [width, setWidth] = useState(savedWidth);
  const maxWidth = () => Math.max(MIN_BROWSER, (host.current?.getBoundingClientRect().width || 1600) - MIN_CHAT);
  const clamp = (value: number) => Math.round(Math.max(MIN_BROWSER, Math.min(value, maxWidth())));
  const change = (value: number) => { const next = clamp(value); setWidth(next); saveWidth(next); };
  const shown = host.current ? clamp(width) : width;

  return <div className="research-split" ref={host}>
    <div className="research-split-chat">{chat}</div>
    <div
      className="research-divider"
      role="separator"
      aria-label="Resize research browser"
      aria-orientation="vertical"
      aria-valuemin={MIN_BROWSER}
      aria-valuemax={Math.round(maxWidth())}
      aria-valuenow={Math.round(shown)}
      tabIndex={0}
      onPointerDown={event => {
        if (event.button !== 0) return;
        drag.current = { x: event.clientX, width: shown };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={event => { if (drag.current) change(drag.current.width + drag.current.x - event.clientX); }}
      onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
      onDoubleClick={() => change(DEFAULT_WIDTH)}
      onKeyDown={event => {
        const step = event.shiftKey ? 64 : 16;
        const next = event.key === 'ArrowLeft' ? shown + step : event.key === 'ArrowRight' ? shown - step : event.key === 'Home' ? MIN_BROWSER : event.key === 'End' ? maxWidth() : null;
        if (next === null) return;
        event.preventDefault();
        change(next);
      }}
    />
    <div className="research-split-browser" style={{ flexBasis: shown, width: shown }}>
      <BrowserPane caseId={caseId} sessionEpoch={sessionEpoch} offline={offline} suspended={suspended} onOpenSettings={onOpenSettings} />
    </div>
  </div>;
}
