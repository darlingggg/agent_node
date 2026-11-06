const WEB_TOOL_NAMES = new Set(['search_web', 'fetch_page']);

export function canUseTool(name, webSearchEnabled) {
  return !WEB_TOOL_NAMES.has(name) || webSearchEnabled === true;
}
