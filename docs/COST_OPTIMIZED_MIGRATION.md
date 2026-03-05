# Cost-Optimized AWS Migration (Spot Singleton)

This migration replaces a large always-on EC2 worker with a cheaper Spot-first worker while keeping the MCP architecture unchanged.

## Why this mode

- Keeps your existing SSH-based `zyphar-mcp-app` flow intact.
- Cuts compute spend significantly versus 24/7 `m7i.4xlarge`.
- Uses Elastic IP so `EC2_HOST` remains stable after cutover.

## Current source worker (detected)

- Instance ID: `i-0dba35abba2b37a24`
- Region: `us-east-2`
- Type: `m7i.4xlarge`

## Prerequisites

- AWS CLI v2 configured with valid credentials:
  - `aws configure` or `aws sso login`
- Permissions for:
  - `ec2:Describe*`
  - `ec2:CreateImage`
  - `ec2:RunInstances`
  - `ec2:AllocateAddress`
  - `ec2:AssociateAddress`
  - `ec2:CreateTags`
  - `ec2:StopInstances` (if using `--stop-source`)

## One-command migration

From repo root:

```bash
cd zyphar-mcp-app
chmod +x ops/aws/migrate_to_spot_singleton.sh
./ops/aws/migrate_to_spot_singleton.sh \
  --region us-east-2 \
  --source-instance-id i-0dba35abba2b37a24 \
  --target-instance-type c7i.2xlarge \
  --volume-size-gb 200 \
  --allocate-eip \
  --stop-source
```

The script prints the new worker endpoint. Use that value for `EC2_HOST`.

## Update MCP runtime env

Set environment variables in your MCP deployment runtime:

```bash
export EC2_HOST=<new-elastic-ip-or-dns>
export SSH_KEY_PATH=/path/to/private/key.pem
```

Restart MCP:

```bash
npm run start
```

## Validation checklist

1. Run a quick tool call that uses SSH (for example `get-job-status` on an existing job dir).
2. Run one new `design-chip` job.
3. Confirm `download-gdsii` returns a valid URL.

## Rollback

If needed, restore old worker quickly:

1. Start old instance:
   ```bash
   aws ec2 start-instances --region us-east-2 --instance-ids i-0dba35abba2b37a24
   ```
2. Point `EC2_HOST` back to the old endpoint.
3. Restart MCP server.

