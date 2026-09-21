import type { AIConfig, AIProfile, Snapshot } from './types';
export const providerNames = { openai: 'OpenAI', anthropic: 'Claude / Anthropic', gemini: 'Gemini / Google', xai: 'Grok / xAI' } as const;
export const defaultConfig: AIConfig = { provider: 'openai', execution: 'auto', review: 'standard', pool: [] };
export const profileKey = (p: AIProfile) => `${p.provider}:${p.model}`;
export function configuredProfiles(snapshot: Snapshot): AIProfile[] {
  const config = snapshot.ai_config ?? defaultConfig;
  const primary: AIProfile = { provider: config.provider, model: snapshot.settings.model, allow_text: snapshot.settings.allow_text, allow_images: snapshot.settings.allow_images };
  return [primary, ...config.pool].filter((p, i, all) => p.model && all.findIndex(x => profileKey(x) === profileKey(p)) === i);
}
