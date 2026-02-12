import { esFetch } from "../../es-client.js";
export function registerNodeStats(server) {
    server.registerTool("node_stats", {
        title: "Node Stats",
        description: "Per-node performance metrics: heap usage, GC pressure, search/indexing latency, " +
            "thread pool queue/rejections. Use to identify resource bottlenecks.",
    }, async () => {
        const result = await esFetch("GET", "/_nodes/stats/indices,jvm,thread_pool");
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
    });
}
//# sourceMappingURL=node-stats.js.map