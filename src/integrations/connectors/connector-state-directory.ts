import path from "node:path";

import type { ServicePlatformInput } from "../service/runtime-directory.js";

export function resolveConnectorStateDirectory(
  platform: ServicePlatformInput,
  override?: string,
): string {
  const platformPath = platform.platform === "win32" ? path.win32 : path.posix;
  const configured = override ?? platform.environment.AGENTFOLD_CONNECTOR_STATE_DIR;
  if (configured !== undefined && configured.trim().length > 0) {
    return platformPath.resolve(configured);
  }
  if (platform.platform === "win32") {
    const localAppData = platform.environment.LOCALAPPDATA;
    if (localAppData === undefined || localAppData.trim().length === 0) {
      throw new Error("LOCALAPPDATA is unavailable for BriefOnce connector state.");
    }
    return path.win32.join(localAppData, "AgentFold", "connectors");
  }
  if (platform.platform === "darwin") {
    return path.posix.join(
      platform.homeDirectory,
      "Library",
      "Application Support",
      "AgentFold",
      "connectors",
    );
  }
  const xdgState = platform.environment.XDG_STATE_HOME;
  return xdgState !== undefined && xdgState.trim().length > 0
    ? path.posix.join(xdgState, "agentfold", "connectors")
    : path.posix.join(platform.homeDirectory, ".local", "state", "agentfold", "connectors");
}
