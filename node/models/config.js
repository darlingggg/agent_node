/** 模型元数据中的 JSON 在 mysql2 下可能已解析，也可能仍是字符串。 */
export function parseModelJson(value) {
  if (typeof value !== 'string') return value ?? null;
  if (!value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('模型元数据 JSON 格式不正确');
  }
}

export function normalizeModel(model) {
  const modelKey = model?.id;
  const modelName = model?.name || modelKey;
  if (
    typeof modelKey !== 'string' ||
    !modelKey.trim() ||
    modelKey.length > 128 ||
    typeof modelName !== 'string' ||
    modelName.length > 128
  ) {
    throw new Error('服务商返回了无效的模型标识或名称');
  }
  const capabilities = { ...(model.capabilities || {}) };
  for (const field of [
    'context_window',
    'max_output_tokens',
    'input_modalities',
    'output_modalities',
    'api_capabilities',
  ]) {
    if (model[field] != null) capabilities[field] = model[field];
  }
  const effort = parseModelJson(model.effort);
  if (effort != null && !Array.isArray(effort.supported_levels)) {
    if (Object.keys(effort).length) throw new Error('服务商返回了无效的推理强度配置');
  }
  if (
    effort?.supported_levels?.some(
      (level) => typeof level !== 'string' || !level.trim() || level.length > 32,
    )
  ) {
    throw new Error('服务商返回了无效的推理强度选项');
  }
  return { modelKey, modelName, capabilities, effort };
}

/** 不提供强度或切换模型时使用服务商默认值；无配置时不发送 reasoning_effort。 */
export function resolveModelConfig(model, requestedEffort) {
  const capabilities = parseModelJson(model.capabilities) || {};
  const effort = parseModelJson(model.effort);
  const levels = effort?.supported_levels || [];
  let reasoningEffort = null;
  if (levels.length) {
    const defaultEffort = levels.includes(effort.default_level) ? effort.default_level : levels[0];
    reasoningEffort =
      requestedEffort == null || requestedEffort === '' ? defaultEffort : requestedEffort;
    if (!levels.includes(reasoningEffort)) throw new Error('当前模型不支持所选推理强度');
  }
  const contextLimit = Number(capabilities.context_window);
  return {
    model: model.model_key,
    reasoningEffort,
    ...(Number.isSafeInteger(contextLimit) && contextLimit >= 4096 ? { contextLimit } : {}),
  };
}

export function modelRequestOptions(config) {
  if (!config?.model) throw new Error('未选择可用模型');
  return {
    model: config.model,
    ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
  };
}
