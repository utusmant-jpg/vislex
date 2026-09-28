// Test-environment shim shared by all vitest suites.
//
// happy-dom implements Element.animate, so `motion` picks native WAAPI
// animations — and happy-dom's Animation.cancel() rejects with AbortError,
// leaking unhandled rejections whenever an animated component unmounts.
// Removing the API makes motion fall back to its rAF frameloop, which stops
// cleanly. No behavior under test depends on the animation engine.
if (typeof Element !== 'undefined' && 'animate' in Element.prototype) {
  Object.defineProperty(Element.prototype, 'animate', { value: undefined, configurable: true });
}

// Lazy-loaded workspaces resolve through dynamic import(); on a loaded machine
// that can exceed testing-library's 1 s default for findBy*/waitFor and fail
// spuriously. A longer ceiling changes no assertion: passing tests return as
// soon as the element appears.
import { configure } from '@testing-library/react';
configure({ asyncUtilTimeout: 5000 });
