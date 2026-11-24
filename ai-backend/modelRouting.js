const DEFAULT_MODEL = 'nvidia/nemotron-3.5-bolt-e4b';
const DEFAULT_FALLBACK_MODELS = [
  'google/gemma-4-31b-it',
  'mistralai/mistral-large-4-1t-a52b',
];
const MAX_MODEL_ROUTES = 9;

function resolveModelRoutes(env = process.env) {
  const configuredModel = String(env.NVIDIA_NIM_MODEL || '').trim();
  const primary = configuredModel || DEFAULT_MODEL;
  const configuredFallbacks = String(env.NVIDIA_NIM_FALLBACK_MODELS || '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  const fallbacks = configuredFallbacks.length ? configuredFallbacks : DEFAULT_FALLBACK_MODELS;
  const models = [...new Set([primary, ...fallbacks])].slice(0, MAX_MODEL_ROUTES);

  return { primary: models[0], models };
}

module.exports = { DEFAULT_MODEL, DEFAULT_FALLBACK_MODELS, MAX_MODEL_ROUTES, resolveModelRoutes };
