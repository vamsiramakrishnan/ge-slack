import {
  ChannelPolicySchema,
  DEFAULT_CHANNEL_POLICY,
  type AgentEntry,
  type ConnectorEntry,
  type ChannelPolicy,
  type ChannelPolicyInput,
  type GroundSource,
  type ResearchUnit,
} from '@ge-slack/contracts';
import type { KeyValueStore } from '@ge-slack/identity';
import type { WorkspaceConfigPort } from './ports.js';

/**
 * Workspace configuration backed by the shared KV store. The `@` catalog is deployment config
 * (admins map aliases to Discovery Engine data stores); channel policy and units are set in-app.
 * Private channels and DMs never default to anything broader than `user-only`.
 */
export class KvWorkspaceConfig implements WorkspaceConfigPort {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly staticCatalog: GroundSource[],
    private readonly staticAgents: AgentEntry[] = [],
    private readonly staticConnectors: ConnectorEntry[] = [],
  ) {}

  async channelPolicy(teamId: string, channel: string): Promise<ChannelPolicy> {
    if (!channel) return DEFAULT_CHANNEL_POLICY;
    const stored = await this.kv.get<ChannelPolicy>(`policy/${teamId}/${channel}`);
    const parsed = ChannelPolicySchema.safeParse(stored ?? {});
    return parsed.success ? parsed.data : DEFAULT_CHANNEL_POLICY;
  }

  async setChannelPolicy(
    teamId: string,
    channel: string,
    policy: ChannelPolicyInput,
  ): Promise<void> {
    await this.kv.set(`policy/${teamId}/${channel}`, ChannelPolicySchema.parse(policy));
  }

  async unit(teamId: string, channel: string): Promise<ResearchUnit | undefined> {
    return this.kv.get<ResearchUnit>(`unit/${teamId}/${channel}`);
  }

  async setUnit(teamId: string, channel: string, unit: ResearchUnit): Promise<void> {
    await this.kv.set(`unit/${teamId}/${channel}`, unit);
  }

  async catalog(_teamId: string): Promise<GroundSource[]> {
    return this.staticCatalog;
  }

  async agents(_teamId: string): Promise<AgentEntry[]> {
    return this.staticAgents;
  }

  async connectors(_teamId: string): Promise<ConnectorEntry[]> {
    return this.staticConnectors;
  }
}
