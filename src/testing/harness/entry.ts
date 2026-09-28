// Dev-only entry for /harness.html. Installs the synthetic backend first, then
// loads the unmodified application entry. Never imported by index.html, so it
// is not part of the production bundle.
import { installHarness } from './install';

const params = new URLSearchParams(window.location.search);
installHarness({
  startWith: params.get('start') === 'empty' ? 'none' : 'A',
  sourceCount: params.has('sources') ? Math.max(8, Math.min(5000, Number(params.get('sources')) || 250)) : undefined,
});
document.documentElement.dataset.harness = 'synthetic';
await import('../../main');
