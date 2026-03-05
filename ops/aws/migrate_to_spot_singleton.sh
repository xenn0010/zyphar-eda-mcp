#!/usr/bin/env bash
set -euo pipefail

# Migrate an existing Zyphar EC2 worker to a cheaper Spot-first singleton worker.
# Requires:
# - AWS CLI v2 configured with credentials that can manage EC2 in target region
# - Existing worker instance to clone
#
# Example:
#   ./ops/aws/migrate_to_spot_singleton.sh \
#     --region us-east-2 \
#     --source-instance-id i-0123456789abcdef0 \
#     --target-instance-type c7i.2xlarge \
#     --volume-size-gb 200 \
#     --allocate-eip \
#     --stop-source

REGION="${REGION:-us-east-2}"
SOURCE_INSTANCE_ID=""
TARGET_INSTANCE_TYPE="c7i.2xlarge"
VOLUME_SIZE_GB="200"
TAG_PREFIX="zyphar-worker"
IMAGE_ID=""
AMI_NAME=""
KEY_NAME=""
SUBNET_ID=""
SECURITY_GROUP_IDS=""
IAM_INSTANCE_PROFILE=""
EIP_ALLOCATION_ID=""
ALLOCATE_EIP="0"
USE_SPOT="1"
STOP_SOURCE="0"
SKIP_AMI_WAIT="0"
DRY_RUN="0"

usage() {
  cat <<'USAGE'
Usage:
  migrate_to_spot_singleton.sh --source-instance-id <id> [options]

Required:
  --source-instance-id ID      Existing EC2 worker instance id to clone

Options:
  --region REGION              AWS region (default: us-east-2)
  --target-instance-type TYPE  New instance type (default: c7i.2xlarge)
  --volume-size-gb N           Root gp3 volume size (default: 200)
  --image-id AMI_ID            Reuse an existing AMI (skip create-image)
  --ami-name NAME              AMI name when creating from source
  --key-name NAME              Override key pair (default: source key pair)
  --subnet-id SUBNET           Override subnet (default: source subnet)
  --security-group-ids "sg-a sg-b"
                               Override SG list (default: source SG list)
  --iam-instance-profile PROFILE
                               Override IAM instance profile name/arn
  --eip-allocation-id eipalloc-...
                               Attach existing Elastic IP
  --allocate-eip               Allocate and attach a new Elastic IP
  --on-demand                  Launch on-demand instead of Spot
  --stop-source                Stop source instance after successful cutover
  --skip-ami-wait              Do not wait for AMI to become available
  --dry-run                    Print actions only; do not mutate resources
  --help                       Show this help
USAGE
}

log() {
  echo "[migrate] $*"
}

fail() {
  echo "[migrate] ERROR: $*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

aws_text() {
  aws "$@" --output text
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-instance-id) SOURCE_INSTANCE_ID="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --target-instance-type) TARGET_INSTANCE_TYPE="$2"; shift 2 ;;
    --volume-size-gb) VOLUME_SIZE_GB="$2"; shift 2 ;;
    --image-id) IMAGE_ID="$2"; shift 2 ;;
    --ami-name) AMI_NAME="$2"; shift 2 ;;
    --key-name) KEY_NAME="$2"; shift 2 ;;
    --subnet-id) SUBNET_ID="$2"; shift 2 ;;
    --security-group-ids) SECURITY_GROUP_IDS="$2"; shift 2 ;;
    --iam-instance-profile) IAM_INSTANCE_PROFILE="$2"; shift 2 ;;
    --eip-allocation-id) EIP_ALLOCATION_ID="$2"; shift 2 ;;
    --allocate-eip) ALLOCATE_EIP="1"; shift 1 ;;
    --on-demand) USE_SPOT="0"; shift 1 ;;
    --stop-source) STOP_SOURCE="1"; shift 1 ;;
    --skip-ami-wait) SKIP_AMI_WAIT="1"; shift 1 ;;
    --dry-run) DRY_RUN="1"; shift 1 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

[[ -n "$SOURCE_INSTANCE_ID" ]] || fail "--source-instance-id is required"
[[ "$VOLUME_SIZE_GB" =~ ^[0-9]+$ ]] || fail "--volume-size-gb must be an integer"

need_cmd aws

if [[ "$DRY_RUN" == "0" ]]; then
  aws sts get-caller-identity >/dev/null
fi

log "Loading source instance metadata: $SOURCE_INSTANCE_ID ($REGION)"
SOURCE_SUBNET_ID="$(aws_text ec2 describe-instances --region "$REGION" --instance-ids "$SOURCE_INSTANCE_ID" --query 'Reservations[0].Instances[0].SubnetId')"
SOURCE_KEY_NAME="$(aws_text ec2 describe-instances --region "$REGION" --instance-ids "$SOURCE_INSTANCE_ID" --query 'Reservations[0].Instances[0].KeyName')"
SOURCE_ROOT_DEVICE_NAME="$(aws_text ec2 describe-instances --region "$REGION" --instance-ids "$SOURCE_INSTANCE_ID" --query 'Reservations[0].Instances[0].RootDeviceName')"
SOURCE_SG_IDS="$(aws_text ec2 describe-instances --region "$REGION" --instance-ids "$SOURCE_INSTANCE_ID" --query 'Reservations[0].Instances[0].SecurityGroups[*].GroupId')"
SOURCE_IAM_ARN="$(aws_text ec2 describe-instances --region "$REGION" --instance-ids "$SOURCE_INSTANCE_ID" --query 'Reservations[0].Instances[0].IamInstanceProfile.Arn' 2>/dev/null || true)"

[[ "$SOURCE_SUBNET_ID" != "None" ]] || fail "Unable to resolve source subnet id"
[[ "$SOURCE_ROOT_DEVICE_NAME" != "None" ]] || fail "Unable to resolve source root device name"

if [[ -z "$SUBNET_ID" ]]; then
  SUBNET_ID="$SOURCE_SUBNET_ID"
fi
if [[ -z "$KEY_NAME" || "$KEY_NAME" == "None" ]]; then
  KEY_NAME="$SOURCE_KEY_NAME"
fi
if [[ -z "$SECURITY_GROUP_IDS" || "$SECURITY_GROUP_IDS" == "None" ]]; then
  SECURITY_GROUP_IDS="$(echo "$SOURCE_SG_IDS" | tr '\t' ' ')"
fi
if [[ -z "$IAM_INSTANCE_PROFILE" ]]; then
  if [[ -n "${SOURCE_IAM_ARN:-}" && "$SOURCE_IAM_ARN" != "None" ]]; then
    IAM_INSTANCE_PROFILE="$SOURCE_IAM_ARN"
  fi
fi

if [[ -z "$IMAGE_ID" ]]; then
  if [[ -z "$AMI_NAME" ]]; then
    AMI_NAME="${TAG_PREFIX}-$(date +%Y%m%d-%H%M%S)"
  fi
  log "Creating AMI from source instance: $AMI_NAME"
  if [[ "$DRY_RUN" == "1" ]]; then
    IMAGE_ID="ami-dry-run-placeholder"
    log "DRY RUN: would create AMI from $SOURCE_INSTANCE_ID"
  else
    IMAGE_ID="$(aws_text ec2 create-image \
      --region "$REGION" \
      --instance-id "$SOURCE_INSTANCE_ID" \
      --name "$AMI_NAME" \
      --description "Zyphar cost-optimized worker AMI from $SOURCE_INSTANCE_ID" \
      --no-reboot \
      --query 'ImageId')"
    log "Created AMI: $IMAGE_ID"
    if [[ "$SKIP_AMI_WAIT" == "0" ]]; then
      log "Waiting for AMI to become available..."
      aws ec2 wait image-available --region "$REGION" --image-ids "$IMAGE_ID"
    fi
  fi
else
  log "Using provided AMI: $IMAGE_ID"
fi

SECURITY_GROUP_IDS="$(echo "$SECURITY_GROUP_IDS" | tr '\t' ' ' | xargs)"
[[ -n "$SECURITY_GROUP_IDS" ]] || fail "No security groups resolved"

read -r -a SG_ARR <<<"$SECURITY_GROUP_IDS"
RUN_ARGS=(
  ec2 run-instances
  --region "$REGION"
  --image-id "$IMAGE_ID"
  --instance-type "$TARGET_INSTANCE_TYPE"
  --subnet-id "$SUBNET_ID"
  --security-group-ids "${SG_ARR[@]}"
  --block-device-mappings "[{\"DeviceName\":\"$SOURCE_ROOT_DEVICE_NAME\",\"Ebs\":{\"VolumeSize\":$VOLUME_SIZE_GB,\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]"
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${TAG_PREFIX}},{Key=Project,Value=Zyphar},{Key=Role,Value=EDAWorker},{Key=ManagedBy,Value=migrate_to_spot_singleton.sh}]"
)

if [[ -n "$KEY_NAME" && "$KEY_NAME" != "None" ]]; then
  RUN_ARGS+=(--key-name "$KEY_NAME")
fi

if [[ -n "$IAM_INSTANCE_PROFILE" && "$IAM_INSTANCE_PROFILE" != "None" ]]; then
  if [[ "$IAM_INSTANCE_PROFILE" == arn:* ]]; then
    RUN_ARGS+=(--iam-instance-profile "Arn=$IAM_INSTANCE_PROFILE")
  else
    RUN_ARGS+=(--iam-instance-profile "Name=$IAM_INSTANCE_PROFILE")
  fi
fi

if [[ "$USE_SPOT" == "1" ]]; then
  RUN_ARGS+=(--instance-market-options "MarketType=spot,SpotOptions={SpotInstanceType=one-time,InstanceInterruptionBehavior=terminate}")
fi

log "Launching new worker: type=$TARGET_INSTANCE_TYPE spot=$USE_SPOT volume=${VOLUME_SIZE_GB}GB"
if [[ "$DRY_RUN" == "1" ]]; then
  echo aws "${RUN_ARGS[@]}"
  NEW_INSTANCE_ID="i-dryrun-placeholder"
else
  NEW_INSTANCE_ID="$(aws_text "${RUN_ARGS[@]}" --query 'Instances[0].InstanceId')"
  log "New instance id: $NEW_INSTANCE_ID"
  aws ec2 wait instance-running --region "$REGION" --instance-ids "$NEW_INSTANCE_ID"
  aws ec2 wait instance-status-ok --region "$REGION" --instance-ids "$NEW_INSTANCE_ID"
fi

if [[ "$ALLOCATE_EIP" == "1" && -z "$EIP_ALLOCATION_ID" ]]; then
  log "Allocating new Elastic IP"
  if [[ "$DRY_RUN" == "1" ]]; then
    EIP_ALLOCATION_ID="eipalloc-dryrun-placeholder"
  else
    EIP_ALLOCATION_ID="$(aws_text ec2 allocate-address --region "$REGION" --domain vpc --query 'AllocationId')"
  fi
fi

PUBLIC_ENDPOINT=""
if [[ -n "$EIP_ALLOCATION_ID" ]]; then
  log "Associating Elastic IP: $EIP_ALLOCATION_ID"
  if [[ "$DRY_RUN" == "1" ]]; then
    PUBLIC_ENDPOINT="<elastic-ip>"
    echo aws ec2 associate-address --region "$REGION" --instance-id "$NEW_INSTANCE_ID" --allocation-id "$EIP_ALLOCATION_ID" --allow-reassociation
  else
    aws ec2 associate-address --region "$REGION" --instance-id "$NEW_INSTANCE_ID" --allocation-id "$EIP_ALLOCATION_ID" --allow-reassociation >/dev/null
    PUBLIC_ENDPOINT="$(aws_text ec2 describe-addresses --region "$REGION" --allocation-ids "$EIP_ALLOCATION_ID" --query 'Addresses[0].PublicIp')"
  fi
else
  if [[ "$DRY_RUN" == "1" ]]; then
    PUBLIC_ENDPOINT="<public-dns-or-ip>"
  else
    PUBLIC_ENDPOINT="$(aws_text ec2 describe-instances --region "$REGION" --instance-ids "$NEW_INSTANCE_ID" --query 'Reservations[0].Instances[0].PublicDnsName')"
    if [[ -z "$PUBLIC_ENDPOINT" || "$PUBLIC_ENDPOINT" == "None" ]]; then
      PUBLIC_ENDPOINT="$(aws_text ec2 describe-instances --region "$REGION" --instance-ids "$NEW_INSTANCE_ID" --query 'Reservations[0].Instances[0].PublicIpAddress')"
    fi
  fi
fi

if [[ "$STOP_SOURCE" == "1" ]]; then
  log "Stopping old source instance: $SOURCE_INSTANCE_ID"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo aws ec2 stop-instances --region "$REGION" --instance-ids "$SOURCE_INSTANCE_ID"
  else
    aws ec2 stop-instances --region "$REGION" --instance-ids "$SOURCE_INSTANCE_ID" >/dev/null
  fi
fi

echo
echo "=== Migration Complete ==="
echo "Region:               $REGION"
echo "Source instance:      $SOURCE_INSTANCE_ID"
echo "New instance:         $NEW_INSTANCE_ID"
echo "Spot worker:          $USE_SPOT"
echo "Worker endpoint:      $PUBLIC_ENDPOINT"
echo "Elastic IP alloc id:  ${EIP_ALLOCATION_ID:-<none>}"
echo
echo "Set this in zyphar-mcp-app runtime env:"
echo "  EC2_HOST=$PUBLIC_ENDPOINT"
echo
echo "Then restart mcp server and run a smoke test:"
echo "  download-gdsii on an existing completed job"

