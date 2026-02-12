import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerUpdateSettings } from "./update-settings.js";
import { registerReindex } from "./reindex.js";
import { registerShrinkIndex } from "./shrink-index.js";
import { registerManageAliases } from "./manage-aliases.js";
import { registerCancelTask } from "./cancel-task.js";
import { registerConfirmOperation } from "./confirm-operation.js";
import { registerCancelOperation } from "./cancel-operation.js";

export function registerWriteTools(server: McpServer): void {
  registerUpdateSettings(server);
  registerReindex(server);
  registerShrinkIndex(server);
  registerManageAliases(server);
  registerCancelTask(server);
  registerConfirmOperation(server);
  registerCancelOperation(server);
}
