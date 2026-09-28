import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

/** Collapsible tool card for the findings workspace. The summary is a single
 *  labelled control (native details/summary keyboard behaviour); the body is
 *  mounted but hidden until opened, so form drafts survive collapsing. */
export default function ToolPanel({ icon, title, description, children, className }: { icon: ReactNode; title: string; description: string; children: ReactNode; className?: string }) {
  return <details className={`tool-panel ${className ?? ''}`}>
    <summary>
      <span className="icon-tile" aria-hidden="true">{icon}</span>
      <span className="tool-panel-text"><span className="tool-panel-title">{title}</span><span className="tool-panel-description">{description}</span></span>
      <ChevronRight size={16} className="tool-panel-chevron" aria-hidden="true" />
    </summary>
    <div className="tool-panel-body">{children}</div>
  </details>;
}
