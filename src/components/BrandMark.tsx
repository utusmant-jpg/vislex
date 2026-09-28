// The VisLex mark: the Aperture V, two blades and the amber evidence point.
// Same geometry as app-icon.svg, so the window, taskbar and in-app mark match.
export default function BrandMark({ large = false, size }: { large?: boolean; size?: number }) {
  const px = size ?? (large ? 48 : 20);
  return <svg className={`brand-mark ${large ? 'large' : ''}`} width={px} height={px} viewBox="0 0 100 100" aria-hidden="true" data-tauri-drag-region>
    <rect width="100" height="100" rx="24" fill="#10121A" />
    <path d="M20 25h15.5l19 52H43.5z" fill="#7F85FF" />
    <path d="M64.5 25H80L57 77l-7-17.5z" fill="#C9CCFF" />
    <rect x="44.5" y="15.5" width="11" height="11" rx="2.6" fill="#F5B942" />
  </svg>;
}
