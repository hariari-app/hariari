export interface NodePtyNativeAssetPlan {
  readonly directory: string;
  readonly required: readonly string[];
  readonly executable: readonly string[];
}

export function nodePtyNativeAssetPlan(options: {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly hasPrebuild: boolean;
}): NodePtyNativeAssetPlan;

export function selectNodePtyNativeAssets(
  plan: NodePtyNativeAssetPlan,
  available: readonly string[],
): string[];

export function nodePtyPrebuildAssetSelector(
  plan: NodePtyNativeAssetPlan,
  rootAvailable: readonly string[],
): (name: string) => boolean;

export function nodePtyAssetMode(
  plan: NodePtyNativeAssetPlan,
  name: string,
  sourceMode: number,
): number;

export function assertNodePtyAssetPlan(
  plan: NodePtyNativeAssetPlan,
  available: readonly string[],
): void;

export function isLoadableNodePtyAsset(name: string): boolean;
