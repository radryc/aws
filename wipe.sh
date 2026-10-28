#!/bin/bash
set -euo pipefail

AWS_PROFILE="${AWS_PROFILE:-default}"
AWS_REGION="${AWS_REGION:-us-east-1}"
FORCE=false

usage() {
    cat <<EOF
usage: ./wipe.sh [--profile PROFILE] [--region REGION] [-f|--force]

  --profile PROFILE   AWS profile (default: \$AWS_PROFILE or default)
  --region  REGION    AWS region  (default: \$AWS_REGION or us-east-1)
  -f|--force          Skip ALL confirmation prompts
  -h|--help           Show this help

Destroys all Strata CDK stacks (StrataStack, AwsPusherStack,
DemoStack) AND force-deletes any lingering resources CDK cannot clean up:
  - S3 blob bucket + all versions
  - ECR repositories
  - EFS filesystem
  - Secrets Manager secrets
  - CloudWatch log groups
  - CDK bootstrap bucket

examples:
  ./wipe.sh
  ./wipe.sh --profile default --force
EOF
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --profile) AWS_PROFILE="$2"; shift 2 ;;
        --region)  AWS_REGION="$2"; shift 2 ;;
        -f|--force) FORCE=true; shift ;;
        -h|--help) usage ;;
        *) echo "unknown flag: $1"; usage ;;
    esac
done

export AWS_PROFILE
export AWS_REGION

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

AWS="aws --profile $AWS_PROFILE --region $AWS_REGION --no-cli-pager"
CDK="npx cdk --profile $AWS_PROFILE"

ACCOUNT=$($AWS sts get-caller-identity --query Account --output text 2>/dev/null) || {
    echo "ERROR: cannot authenticate with profile '$AWS_PROFILE'"
    echo "run: aws sso login --profile $AWS_PROFILE --no-browser"
    exit 1
}

echo "============================================="
echo "  STRATA AWS — WIPE EVERYTHING"
echo "  account : $ACCOUNT"
echo "  region  : $AWS_REGION"
echo "  profile : $AWS_PROFILE"
echo "============================================="
echo ""

if ! $FORCE; then
    echo "THIS WILL DESTROY ALL STRATA RESOURCES IN ACCOUNT $ACCOUNT."
    read -r -p "type 'yes' to confirm: " REPLY
    if [[ "$REPLY" != "yes" ]]; then
        echo "aborted"
        exit 0
    fi
    echo ""
fi

# ═══════════════════════════════════════════════════════════════
# STEP 1: CDK destroy (CloudFormation stack)
# ═══════════════════════════════════════════════════════════════
echo "[1/6] CDK destroy (all app stacks)..."
# The app defines StrataStack + AwsPusherStack + DemoStack, so `--all` is
# required; otherwise CDK refuses ("app includes more than a single stack").
$CDK destroy --all --force 2>&1 || {
    echo "WARNING: cdk destroy failed — falling back to direct CloudFormation deletion"
}

# Fallback: delete any app stack still present directly. The CDKToolkit stack
# (and its cfn-exec role) is deleted LAST, so the stacks' role still resolves.
for stack in StrataStack AwsPusherStack DemoStack; do
    status=$($AWS cloudformation describe-stacks --stack-name "$stack" \
        --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo "")
    if [[ -n "$status" ]]; then
        echo "  deleting leftover stack $stack ($status)..."
        $AWS cloudformation delete-stack --stack-name "$stack" 2>/dev/null || true
    fi
done
for stack in StrataStack AwsPusherStack DemoStack; do
    $AWS cloudformation wait stack-delete-complete --stack-name "$stack" 2>/dev/null || true
done
echo "  ok"

# ═══════════════════════════════════════════════════════════════
# STEP 2: S3 — delete blob bucket + CDK bootstrap bucket
# ═══════════════════════════════════════════════════════════════
echo "[2/6] S3 — wiping all strata buckets..."

BLOB_BUCKET="monofs-blobs-${ACCOUNT}-${AWS_REGION}"
BOOTSTRAP_BUCKET="cdk-hnb659fds-assets-${ACCOUNT}-${AWS_REGION}"

# Delete every object version + delete marker, then the bucket. Handles
# versioned buckets (the blob bucket is versioned and can otherwise survive
# `cdk destroy`, breaking the next deploy with "bucket already exists").
empty_bucket() {
    local bucket="$1" kind q payload n
    if ! $AWS s3api head-bucket --bucket "$bucket" 2>/dev/null; then
        return 0
    fi
    echo "  emptying $bucket (versions + delete markers)..."
    for kind in Versions DeleteMarkers; do
        for _ in $(seq 1 1000); do
            q="{Objects: ($kind || [])[].{Key:Key,VersionId:VersionId}}"
            payload=$($AWS s3api list-object-versions --bucket "$bucket" --max-items 1000 \
                --query "$q" --output json 2>/dev/null || echo '{"Objects":[]}')
            n=$(printf '%s' "$payload" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("Objects") or []))' 2>/dev/null || echo 0)
            [ "$n" = "0" ] && break
            $AWS s3api delete-objects --bucket "$bucket" --delete "$payload" >/dev/null 2>&1 || break
        done
    done
    $AWS s3 rb "s3://$bucket" --force >/dev/null 2>&1 || true
    if $AWS s3api head-bucket --bucket "$bucket" 2>/dev/null; then
        echo "  WARNING: $bucket still exists"
    else
        echo "  $bucket deleted"
    fi
}

empty_bucket "$BLOB_BUCKET"
empty_bucket "$BOOTSTRAP_BUCKET"

for bucket in $($AWS s3api list-buckets --query "Buckets[?starts_with(Name, 'cdk-')].Name" --output text 2>/dev/null); do
    empty_bucket "$bucket"
done

echo "  ok"

# ═══════════════════════════════════════════════════════════════
# STEP 3: ECR — delete all strata image repositories
# ═══════════════════════════════════════════════════════════════
echo "[3/6] ECR — wiping strata repositories..."

ECR_REPOS=$($AWS ecr describe-repositories --query "repositories[].repositoryName" --output text 2>/dev/null || echo "")
for repo in $ECR_REPOS; do
    case "$repo" in
        aws-cdk/assets*|cdk-hnb659fds-container-assets-*|strata/*|monofs-*|guardian*)
            echo "  deleting ECR repo: $repo"
            $AWS ecr delete-repository --repository-name "$repo" --force 2>/dev/null || true
            ;;
    esac
done

echo "  ok"

# ═══════════════════════════════════════════════════════════════
# STEP 4: EFS — delete any lingering filesystems
# ═══════════════════════════════════════════════════════════════
echo "[4/6] EFS — deleting mount targets + filesystems..."

EFS_IDS=$($AWS efs describe-file-systems --query "FileSystems[].FileSystemId" --output text 2>/dev/null || echo "")
for fsid in $EFS_IDS; do
    FS_NAME=$($AWS efs describe-file-systems --file-system-id "$fsid" --query "FileSystems[0].Name" --output text 2>/dev/null || echo "")
    # Only touch filesystems owned by this stack: named "strata*" or carrying a
    # CloudFormation stack tag for one of the app stacks. Never delete unnamed
    # EFS systems, which may belong to other workloads in the account.
    FS_STACK=$($AWS efs list-tags-for-resource --resource-id "$fsid" \
        --query "Tags[?Key=='aws:cloudformation:stack-name'].Value" --output text 2>/dev/null || echo "")
    if [[ "$FS_NAME" == *"strata"* ]] || [[ "$FS_STACK" == "StrataStack" ]] || \
       [[ "$FS_STACK" == "AwsPusherStack" ]] || [[ "$FS_STACK" == "DemoStack" ]]; then
        echo "  found EFS $fsid — deleting mount targets..."
        MT_IDS=$($AWS efs describe-mount-targets --file-system-id "$fsid" --query "MountTargets[].MountTargetId" --output text 2>/dev/null || echo "")
        for mt in $MT_IDS; do
            $AWS efs delete-mount-target --mount-target-id "$mt" 2>/dev/null || true
        done
        echo "  waiting for mount targets to delete..."
        sleep 30
        echo "  deleting filesystem $fsid..."
        $AWS efs delete-file-system --file-system-id "$fsid" 2>/dev/null || true
    fi
done

echo "  ok"

# ═══════════════════════════════════════════════════════════════
# STEP 5: Secrets Manager
# ═══════════════════════════════════════════════════════════════
echo "[5/6] Secrets Manager — deleting strata secrets..."

for secret_arn in $($AWS secretsmanager list-secrets --query "SecretList[?starts_with(Name, 'strata/')].ARN" --output text 2>/dev/null || echo ""); do
    echo "  deleting $secret_arn"
    $AWS secretsmanager delete-secret --secret-id "$secret_arn" --force-delete-without-recovery 2>/dev/null || true
done

echo "  ok"

# ═══════════════════════════════════════════════════════════════
# STEP 6: CloudWatch Log Groups
# ═══════════════════════════════════════════════════════════════
echo "[6/6] CloudWatch — deleting log groups..."

for lg in $($AWS logs describe-log-groups --log-group-name-prefix "/ecs/strata" --query "logGroups[].logGroupName" --output text 2>/dev/null || echo ""); do
    echo "  deleting $lg"
    $AWS logs delete-log-group --log-group-name "$lg" 2>/dev/null || true
done

# Also clean any /aws/ecs/strata or container insights log groups
for lg in $($AWS logs describe-log-groups --log-group-name-prefix "/aws/ecs/containerinsights/strata" --query "logGroups[].logGroupName" --output text 2>/dev/null || echo ""); do
    echo "  deleting $lg"
    $AWS logs delete-log-group --log-group-name "$lg" 2>/dev/null || true
done

echo "  ok"

# ═══════════════════════════════════════════════════════════════
# STEP 7: CDKToolkit bootstrap stack — delete LAST
# ═══════════════════════════════════════════════════════════════
# The app stacks above are deleted using the bootstrap's cfn-exec role, so the
# toolkit must only be removed once they are gone. Its bucket + container repo
# were already emptied in steps 2–3. deploy.sh re-bootstraps automatically.
echo "[7/7] deleting CDKToolkit bootstrap stack..."
if $AWS cloudformation describe-stacks --stack-name CDKToolkit >/dev/null 2>&1; then
    $AWS cloudformation delete-stack --stack-name CDKToolkit 2>/dev/null || true
    $AWS cloudformation wait stack-delete-complete --stack-name CDKToolkit 2>/dev/null || true
    echo "  CDKToolkit deleted"
else
    echo "  CDKToolkit not present"
fi
echo "  ok"

# ═══════════════════════════════════════════════════════════════
# FINAL VERIFICATION
# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== verification ==="

REMAINING=false

for stack in StrataStack AwsPusherStack DemoStack; do
    REMAINING_CFN=$($AWS cloudformation describe-stacks --stack-name "$stack" --query "Stacks[0].StackName" --output text 2>/dev/null || echo "")
    if [[ -n "$REMAINING_CFN" ]]; then
        echo "WARNING: $stack CloudFormation stack still exists"
        REMAINING=true
    fi
done

REMAINING_BLOB=$($AWS s3api head-bucket --bucket "$BLOB_BUCKET" 2>&1 || true)
if ! echo "$REMAINING_BLOB" | grep -q 'Not Found\|404'; then
    echo "WARNING: blob bucket $BLOB_BUCKET still exists"
    REMAINING=true
fi

REMAINING_ECR=$($AWS ecr describe-repositories --query "repositories[?starts_with(repositoryName, 'aws-cdk/assets')].repositoryName" --output text 2>/dev/null || echo "")
if [[ -n "$REMAINING_ECR" ]]; then
    echo "WARNING: ECR repos still present: $REMAINING_ECR"
    REMAINING=true
fi

REMAINING_SECRETS=$($AWS secretsmanager list-secrets --query "SecretList[?starts_with(Name, 'strata/')].ARN" --output text 2>/dev/null || echo "")
if [[ -n "$REMAINING_SECRETS" ]]; then
    echo "WARNING: secrets still present: $REMAINING_SECRETS"
    REMAINING=true
fi

if $REMAINING; then
    echo ""
    echo "Some resources remain. Re-run with --force to retry."
    echo "Or wait a few minutes for CloudFormation to finish cleanup."
else
    echo "All strata resources confirmed deleted."
fi

echo ""
echo "=== wipe complete ==="
