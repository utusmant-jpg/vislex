import type { AIConfig, AIProfile, Provider, Snapshot } from './types';
export const providerNames = { openai: 'OpenAI', anthropic: 'Claude / Anthropic', gemini: 'Gemini / Google', xai: 'Grok / xAI', openrouter: 'OpenRouter · many models', zai: 'Z.ai · GLM Coding Plan' } as const;
export const defaultConfig: AIConfig = { provider: 'openai', execution: 'auto', review: 'standard', pool: [] };
export const profileKey = (p: AIProfile) => `${p.provider}:${p.model}`;
/** Z.ai documents GLM-5.3 as text-only and GLM-5.3-Flash (and the GLM "V"
 *  vision family) as image-capable; mirrors providers::model_sees_images.
 *  Other providers' image support is left to their own APIs. */
export function modelSeesImages(provider: Provider | undefined, model: string): boolean {
  if (provider !== 'zai') return true;
  const base = (model.split('/').pop() ?? model).split(':')[0].toLowerCase();
  const version = base.split('-')[1] ?? '';
  return base.startsWith('glm-5.3-flash') || (/^\d/.test(version) && version.endsWith('v'));
}
export function configuredProfiles(snapshot: Snapshot): AIProfile[] {
  const config = snapshot.ai_config ?? defaultConfig;
  const primary: AIProfile = { provider: config.provider, model: snapshot.settings.model, allow_text: snapshot.settings.allow_text, allow_images: snapshot.settings.allow_images };
  return [primary, ...config.pool].filter((p, i, all) => p.model && all.findIndex(x => profileKey(x) === profileKey(p)) === i);
}
