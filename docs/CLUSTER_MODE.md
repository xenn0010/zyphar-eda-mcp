# Cluster Mode (Multiple EC2 Workers)

`zyphar-mcp-app` supports multiple SSH workers for parallel job execution.

## Configure workers

Set one of:

```bash
export EC2_HOSTS="worker1.example.com,worker2.example.com,worker3.example.com"
```

or:

```bash
export EC2_HOST="worker1.example.com"
```

`EC2_HOSTS` takes precedence. Jobs are assigned to the least-loaded worker.

## Behavior

- New background jobs are pinned to one worker (`workerHost`).
- Job status, GDS upload/download, DRC/LVS, and wrapper tools use the pinned worker.
- If the server restarts, host mapping is recovered from Convex (`workerHost`) or by probing workers.

## Requirements

- All workers must have the same Zyphar toolchain and PDK paths.
- SSH key/user used by MCP must access all workers.
- Shared API/Convex backend should be the same for all requests.

