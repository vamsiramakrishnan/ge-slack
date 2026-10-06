/**
 * Endpoint + resource-path construction for Discovery Engine (Gemini Enterprise). Residency is
 * pinned by choosing the regional endpoint; there is never a silent global fallback.
 * Ported from ge-msft `@ge/gemini-client` config.
 */

export interface AssistantPath {
  project: string;
  /** 'global' | 'us' | 'eu' | a regional id — must match the tenant's residency commitment. */
  location: string;
  collection?: string;
  engine: string;
  assistant?: string;
}

export interface GeminiSkillMention {
  label: string;
  uri: string;
}

/** Which skill set to mount for a turn: none (chat), the planner, or the command executor. */
export type GeminiSkillRoute = 'default' | 'planner' | 'command';

export interface GeminiClientConfig {
  assistant: AssistantPath;
  modelId?: string;
  skills?: string[];
  skillMentions?: GeminiSkillMention[];
  plannerSkills?: string[];
  plannerSkillMentions?: GeminiSkillMention[];
  commandSkills?: string[];
  commandSkillMentions?: GeminiSkillMention[];
  /**
   * Also name skills in `agentsSpec` (alongside the mention marker). ge-msft re-verified this live
   * in 2026-08; an earlier probe saw 500s. Set false to route skills by mention only. Default true.
   */
  skillAgentsSpec?: boolean;
  /**
   * Let the engine serve connector actions on streamAssist. Default false: ge-slack sends
   * `actionSpec.actionDisabled` so every write goes through its own approval gate.
   */
  engineActions?: boolean;
  /**
   * Optional transparent egress proxy (CORS/audit). The bearer token is attached to it, so it
   * must be https (localhost http allowed for dev only).
   */
  proxyUrl?: string;
}

const GLOBAL_HOST = 'https://discoveryengine.googleapis.com';

export function discoveryEngineHost(location: string): string {
  if (location === 'global') return GLOBAL_HOST;
  if (!location) {
    throw new Error(
      'Discovery Engine location is required (residency pin): set GE_LOCATION to a region ' +
        '(e.g. "eu", "us") or the explicit value "global".',
    );
  }
  if (!/^[a-z0-9-]+$/.test(location))
    throw new Error(`Invalid Discovery Engine location: ${location}`);
  return `https://discoveryengine.${location}.rep.googleapis.com`;
}

export function proxyBase(proxyUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new Error(`Invalid proxyUrl: ${proxyUrl}`);
  }
  const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalhost)) {
    throw new Error(
      `proxyUrl must be https (the bearer token is attached to it): got ${parsed.protocol}`,
    );
  }
  return proxyUrl.replace(/\/$/, '');
}

export function assistantResourceName(p: AssistantPath): string {
  const collection = p.collection ?? 'default_collection';
  const assistant = p.assistant ?? 'default_assistant';
  return (
    `projects/${p.project}/locations/${p.location}/collections/${collection}` +
    `/engines/${p.engine}/assistants/${assistant}`
  );
}

export function collectionResourceName(p: AssistantPath): string {
  return `projects/${p.project}/locations/${p.location}/collections/${p.collection ?? 'default_collection'}`;
}

export function dataStoreResourceName(p: AssistantPath, dataStoreId: string): string {
  return `${collectionResourceName(p)}/dataStores/${dataStoreId}`;
}

/** Gemini Enterprise A2A proxy for a full-code agent (`v1` only). */
export function a2aStreamUrl(cfg: GeminiClientConfig, agentId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(agentId)) throw new Error(`Invalid agent id: ${agentId}`);
  if (cfg.proxyUrl) return `${proxyBase(cfg.proxyUrl)}/a2a/${agentId}/message:stream`;
  return (
    `${discoveryEngineHost(cfg.assistant.location)}/v1/${assistantResourceName(cfg.assistant)}` +
    `/agents/${agentId}/a2a/v1/message:stream`
  );
}

export function streamAssistUrl(cfg: GeminiClientConfig): string {
  if (cfg.proxyUrl) return `${proxyBase(cfg.proxyUrl)}/streamAssist`;
  return `${discoveryEngineHost(cfg.assistant.location)}/v1alpha/${assistantResourceName(cfg.assistant)}:streamAssist`;
}
