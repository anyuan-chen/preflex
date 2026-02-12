import { esFetch } from "../../es-client.js";
export function registerRunningTasks(server) {
    server.registerTool("running_tasks", {
        title: "Running Tasks",
        description: "List currently running search tasks with durations and query bodies. " +
            "Use to find long-running or stuck queries that may need to be cancelled.",
    }, async () => {
        const result = await esFetch("GET", "/_tasks?detailed=true&actions=*search*");
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
    });
}
//# sourceMappingURL=running-tasks.js.map