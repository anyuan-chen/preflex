import { registerClusterHealth } from "./cluster-health.js";
import { registerIndexInfo } from "./index-info.js";
import { registerShardInfo } from "./shard-info.js";
import { registerNodeStats } from "./node-stats.js";
import { registerIndexMapping } from "./index-mapping.js";
import { registerFieldCaps } from "./field-caps.js";
import { registerIndexSettings } from "./index-settings.js";
import { registerIndexStats } from "./index-stats.js";
import { registerAllocationExplain } from "./allocation-explain.js";
import { registerQueryProfile } from "./query-profile.js";
import { registerRunningTasks } from "./running-tasks.js";
export function registerReadTools(server) {
    registerClusterHealth(server);
    registerIndexInfo(server);
    registerShardInfo(server);
    registerNodeStats(server);
    registerIndexMapping(server);
    registerFieldCaps(server);
    registerIndexSettings(server);
    registerIndexStats(server);
    registerAllocationExplain(server);
    registerQueryProfile(server);
    registerRunningTasks(server);
}
//# sourceMappingURL=index.js.map