// Runs only against a new empty synthetic case in a separate WebView profile.
(async () => {
  const invoke = async (action, args = {}) => window.__TAURI_INTERNALS__.invoke('command', { action, args });
  const path = __CASE_PATH__;
  const waitFor = async (find, label) => {
    for (let i = 0; i < 100; i++) {
      const value = find();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for ' + label);
  };
  if (__PHASE__ === 2) {
    let snapshot = await invoke('snapshot');
    for (let i = 0; !snapshot && i < 30; i++) { await new Promise(resolve => setTimeout(resolve, 100)); snapshot = await invoke('snapshot'); }
    if (!snapshot) snapshot = await invoke('open_case', { path });
    const direct = await invoke('direct_media_permission');
    if (!snapshot.settings.offline || snapshot.settings.allow_text || snapshot.settings.allow_images || direct.enabled) throw new Error('Reopen broadened a revoked permission');
    return { phase: 'reopen', case_id: snapshot.id, offline: snapshot.settings.offline, text: snapshot.settings.allow_text, images: snapshot.settings.allow_images, direct_media: direct.enabled };
  }
  await invoke('create_case', { path, name: 'Synthetic consent acceptance' });
  const initial = await invoke('snapshot');
  await invoke('save_settings', { settings: { ...initial.settings, offline: true, allow_text: false, allow_images: false, model: 'synthetic' } });
  const settingsButton = await waitFor(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Settings' && !button.disabled), 'Settings button');
  settingsButton.click();
  const dialog = await waitFor(() => document.querySelector('dialog.settings-sheet[open]'), 'Settings dialog');
  const text = dialog.querySelector('.case-permissions input[type="checkbox"]');
  const images = dialog.querySelectorAll('.case-permissions input[type="checkbox"]')[1];
  if (!text || !images) throw new Error('Case permission controls are missing');
  if (text.checked || images.checked) throw new Error('Settings UI did not show revoked permissions');
  text.click();
  images.click();
  const review = [...dialog.querySelectorAll('select')].find(select => [...select.options].some(option => option.value === 'challenge'));
  const execution = [...dialog.querySelectorAll('select')].find(select => [...select.options].some(option => option.value === 'single'));
  review.value = 'challenge'; review.dispatchEvent(new Event('change', { bubbles: true }));
  execution.value = 'single'; execution.dispatchEvent(new Event('change', { bubbles: true }));
  const directAllow = [...dialog.querySelectorAll('button')].find(button => button.textContent.includes('original audio/video may be sent'));
  await waitFor(() => directAllow && !directAllow.disabled, 'direct media consent');
  directAllow.click();
  await waitFor(() => directAllow.classList.contains('selected'), 'selected direct media consent');
  const saveButton = [...dialog.querySelectorAll('button')].find(button => button.textContent.includes('Save settings & keys'));
  saveButton.click();
  await waitFor(() => !document.querySelector('dialog.settings-sheet[open]'), 'settings save');
  const granted = await invoke('snapshot');
  const directGranted = await invoke('direct_media_permission');
  if (!granted.settings.offline || !granted.settings.allow_text || !granted.settings.allow_images || granted.ai_config.review !== 'challenge' || granted.ai_config.execution !== 'single' || !directGranted.enabled) throw new Error('UI choices did not persist exactly: ' + JSON.stringify({ settings: granted.settings, review: granted.ai_config.review, execution: granted.ai_config.execution, direct_media: directGranted.enabled }));
  settingsButton.click();
  const revokeDialog = await waitFor(() => document.querySelector('dialog.settings-sheet[open]'), 'reopened settings');
  const revokeText = revokeDialog.querySelector('.case-permissions input[type="checkbox"]');
  revokeText.click();
  const directBlock = [...revokeDialog.querySelectorAll('button')].find(button => button.textContent === 'Blocked');
  directBlock.click();
  await waitFor(() => directBlock.classList.contains('selected'), 'selected direct media block');
  const revokeSave = [...revokeDialog.querySelectorAll('button')].find(button => button.textContent.includes('Save settings & keys'));
  revokeSave.click();
  await waitFor(() => !document.querySelector('dialog.settings-sheet[open]'), 'revocation save');
  const revoked = await invoke('snapshot');
  const directRevoked = await invoke('direct_media_permission');
  if (!revoked.settings.offline || revoked.settings.allow_text || revoked.settings.allow_images || directRevoked.enabled) throw new Error('UI revocation did not persist');
  return { phase: 'ui', case_id: revoked.id, initial_offline: initial.settings.offline, granted_text_images_and_direct_media: true, review: granted.ai_config.review, execution: granted.ai_config.execution, revoked_all_media: true };
})()
