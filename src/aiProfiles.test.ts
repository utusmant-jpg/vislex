import { describe, expect, it } from 'vitest';
import { configuredProfiles, modelSeesImages } from './aiProfiles';
import { sampleSnapshot } from './bridge';
describe('enabled model choices', () => {
  it('keeps all configured companies and removes duplicate primary models', () => {
    const snapshot = sampleSnapshot(); snapshot.settings.model = 'openai-test'; snapshot.settings.allow_text = true;
    snapshot.ai_config = { provider: 'openai', execution: 'auto', review: 'standard', pool: [
      { provider: 'gemini', model: 'gemini-test', allow_text: true, allow_images: true },
      { provider: 'anthropic', model: 'claude-test', allow_text: true, allow_images: false },
      { provider: 'openai', model: 'openai-test', allow_text: true, allow_images: false },
    ] };
    expect(configuredProfiles(snapshot).map(p => p.provider)).toEqual(['openai', 'gemini', 'anthropic']);
    expect(snapshot.ai_config.pool).toHaveLength(3);
  });
  it('does not invent a model before configuration', () => {
    expect(configuredProfiles(sampleSnapshot())).toEqual([]);
  });
});
describe('Z.ai image capability', () => {
  it('follows the published GLM model cards and leaves other providers alone', () => {
    expect(modelSeesImages('zai', 'glm-5.3')).toBe(false);
    expect(modelSeesImages('zai', 'glm-4.7-flash')).toBe(false);
    expect(modelSeesImages('zai', 'glm-5.3-flash')).toBe(true);
    expect(modelSeesImages('zai', 'glm-4.6v')).toBe(true);
    expect(modelSeesImages('openai', 'gpt-5')).toBe(true);
  });
});
