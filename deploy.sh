#!/bin/bash
set -euo pipefail

AWS_PROFILE="${AWS_PROFILE:-default}"
AWS_REGION="${AWS_REGION:-us-east-1}"
SKIP_KEY=false
SKIP_DIFF=false

usage() {
    cat <<EOF
usage: ./deploy.sh [flags]

  --profile PROFILE   AWS profile (default: \$AWS_PROFILE or default)
  --region  REGION    AWS region  (default: \$AWS_REGION or us-east-1)
  --with-pusher       Also deploy the AwsPusherStack (separate pusher stack)
  --with-demo         Also deploy the DemoStack (S3 + SSM + Secret + tiny ECS)
  --all               Deploy StrataStack + AwsPusherStack + DemoStack
  --skip-key          Skip encryption-key check
  --skip-diff         Skip cdk diff preview
  -y|--yes            Skip all confirmation prompts
  -h|--help           Show this help

stacks:
  StrataStack        MonoFS + Guardian (always deployed)
  AwsPusherStack     AWS pusher (aws-<account>) — opt-in via --with-pusher
  DemoStack          demo resources for scan/import/deploy — via --with-demo

examples:
  ./deploy.sh
  ./deploy.sh --all -y
  ./deploy.sh --with-demo -y
  ./deploy.sh --with-pusher --with-demo -y
  ./deploy.sh --profile prod-admin --region eu-west-1
EOF
    exit 0
}

SKIP_CONFIRM=false
WITH_PUSHER=false
WITH_DEMO=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --profile)     AWS_PROFILE="$2"; shift 2 ;;
        --region)      AWS_REGION="$2"; shift 2 ;;
        --with-pusher) WITH_PUSHER=true; shift ;;
        --with-demo)   WITH_DEMO=true; shift ;;
        --all)         WITH_PUSHER=true; WITH_DEMO=true; shift ;;
        --skip-key)    SKIP_KEY=true; shift ;;
        --skip-diff)   SKIP_DIFF=true; shift ;;
        -y|--yes)      SKIP_CONFIRM=true; shift ;;
        -h|--help)     usage ;;
        *) echo "unknown flag: $1"; usage ;;
    esac
done

STACKS=("StrataStack")
$WITH_PUSHER && STACKS+=("AwsPusherStack")
$WITH_DEMO && STACKS+=("DemoStack")

export AWS_PROFILE
export AWS_REGION

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

AWS="aws --profile $AWS_PROFILE --region $AWS_REGION --no-cli-pager"

echo "=== strata aws deploy ==="
echo "  profile : $AWS_PROFILE"
echo "  region  : $AWS_REGION"
echo "  stacks  : ${STACKS[*]}"
echo ""

# ---- verify prereqs ----
echo "[1/6] checking prerequisites..."

command -v node >/dev/null 2>&1 || { echo "ERROR: node is required"; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "ERROR: npm is required"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "ERROR: docker is required (running)"; exit 1; }
docker info >/dev/null 2>&1 || { echo "ERROR: docker daemon not running"; exit 1; }

ACCOUNT=$($AWS sts get-caller-identity --query Account --output text 2>/dev/null) || {
    echo "ERROR: cannot authenticate with profile '$AWS_PROFILE'"
    echo "run: aws sso login --profile $AWS_PROFILE --no-browser"
    exit 1
}
echo "  account : $ACCOUNT"
echo "  ok"

# ---- npm install ----
echo "[2/6] npm install..."
if [ ! -d "node_modules" ]; then
    npm install
else
    npm install --silent
fi
echo "  ok"

# ---- build typescript ----
echo "[3/6] building typescript..."
npx tsc
echo "  ok"

# ---- encryption key ----
if ! $SKIP_KEY; then
    echo "[4/6] checking encryption key..."
    KEY_EXISTS=$($AWS secretsmanager describe-secret --secret-id strata/monofs/encryption-key --query ARN --output text 2>/dev/null || echo "")
    KEY_VALUE=$($AWS secretsmanager get-secret-value --secret-id strata/monofs/encryption-key --query SecretString --output text 2>/dev/null || echo "")

    if [[ -n "$KEY_EXISTS" ]] && [[ "$KEY_VALUE" != "PLACEHOLDER" ]] && [[ "${#KEY_VALUE}" -ge 64 ]]; then
        echo "  encryption key already set"
    elif [[ -n "$KEY_EXISTS" ]]; then
        echo "  encryption key exists but looks like a placeholder — updating..."
        NEW_KEY=$(openssl rand -hex 32)
        $AWS secretsmanager put-secret-value \
            --secret-id strata/monofs/encryption-key \
            --secret-string "$NEW_KEY"
        echo "  encryption key set"
    else
        echo "  secret does not exist yet — will be created by CDK."
        echo "  SET IT AFTER DEPLOY:"
        echo "    aws secretsmanager put-secret-value \\"
        echo "      --secret-id strata/monofs/encryption-key \\"
        echo "      --secret-string \"\$(openssl rand -hex 32)\""
        echo "      --profile $AWS_PROFILE --region $AWS_REGION"
        echo "  then restart the monofs-server service."
    fi
    echo "  ok"
else
    echo "[4/6] encryption key (skipped)"
fi

# ---- clean up a failed stack (ROLLBACK_* stacks cannot be updated) ----
STACK_STATUS=$($AWS cloudformation describe-stacks --stack-name StrataStack \
    --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo "NONE")
if [ "$STACK_STATUS" = "ROLLBACK_COMPLETE" ] || [ "$STACK_STATUS" = "ROLLBACK_FAILED" ] || [ "$STACK_STATUS" = "DELETE_FAILED" ] || [ "$STACK_STATUS" = "CREATE_FAILED" ] || [ "$STACK_STATUS" = "UPDATE_FAILED" ]; then
    echo "  stack is $STACK_STATUS — deleting before re-deploy..."
    $AWS cloudformation delete-stack --stack-name StrataStack 2>/dev/null || true
    $AWS cloudformation wait stack-delete-complete --stack-name StrataStack 2>/dev/null || true
    # force-delete any versioned buckets orphaned by the failed stack
    for b in "monofs-blobs-${ACCOUNT}-${AWS_REGION}"; do
        if $AWS s3api head-bucket --bucket "$b" 2>/dev/null; then
            echo "  removing leftover bucket $b..."
            for kind in Versions DeleteMarkers; do
                for _ in $(seq 1 1000); do
                    payload=$($AWS s3api list-object-versions --bucket "$b" --max-items 1000 \
                        --query "{Objects: ($kind || [])[].{Key:Key,VersionId:VersionId}}" --output json 2>/dev/null || echo '{"Objects":[]}')
                    n=$(printf '%s' "$payload" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("Objects") or []))' 2>/dev/null || echo 0)
                    [ "$n" = "0" ] && break
                    $AWS s3api delete-objects --bucket "$b" --delete "$payload" >/dev/null 2>&1 || break
                done
            done
            $AWS s3 rb "s3://$b" --force >/dev/null 2>&1 || true
        fi
    done
fi

# ---- cdk bootstrap (idempotent) ----
echo "[5/6] cdk bootstrap..."
if ! $AWS ssm get-parameter --name /cdk-bootstrap/hnb659fds/version --query Parameter.Value --output text >/dev/null 2>&1; then
    echo "  bootstrapping CDK in $ACCOUNT/$AWS_REGION..."
    npx cdk bootstrap "aws://$ACCOUNT/$AWS_REGION" --profile "$AWS_PROFILE" >/dev/null 2>&1 || {
        echo "ERROR: cdk bootstrap failed"; exit 1
    }
fi

# ---- cdk synth ----
echo "  cdk synth..."
npx cdk synth "${STACKS[@]}" --profile "$AWS_PROFILE" --quiet
echo "  ok"

# ---- cdk diff ----
if ! $SKIP_DIFF; then
    echo ""
    echo "=== changes preview ==="
    npx cdk diff "${STACKS[@]}" --profile "$AWS_PROFILE" || true
    echo ""

    if ! $SKIP_CONFIRM; then
        read -r -p "apply these changes? [y/N] " REPLY
        if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
            echo "aborted"
            exit 0
        fi
    fi
else
    echo "[5/6] cdk diff (skipped)"
fi

# ---- cdk deploy ----
echo ""
echo "[6/6] cdk deploy..."
npx cdk deploy "${STACKS[@]}" --profile "$AWS_PROFILE" --require-approval never

echo ""
echo "=== deploy complete ==="
echo ""

OUTPUTS=$($AWS cloudformation describe-stacks --stack-name StrataStack \
    --query "Stacks[0].Outputs" --output json 2>/dev/null || echo "[]")
get_out() {
    printf '%s' "$OUTPUTS" | python3 -c \
        'import sys,json;d=json.load(sys.stdin);print(next((o["OutputValue"] for o in d if o["OutputKey"]=="'"$1"'"),""))' 2>/dev/null
}

APP_URL=$(get_out AppUrl)
ALB_DNS=$(get_out AlbDnsName)
POOL=$(get_out CognitoUserPoolId)
HOSTED=$(get_out CognitoHostedUIUrl)
ADMIN_PW="${STRATA_ADMIN_PASSWORD:-StrataDemo2026!}"

echo "  App URL      : $APP_URL"
echo "  ALB DNS      : $ALB_DNS"

if [ -n "$POOL" ]; then
    echo "  Cognito pool : $POOL"
    echo ""
    echo "  Ensuring admin user admin@example.com exists..."
    $AWS cognito-idp admin-create-user \
        --user-pool-id "$POOL" --username admin@example.com \
        --user-attributes Name=email,Value=admin@example.com Name=email_verified,Value=true \
        --message-action SUPPRESS >/dev/null 2>&1 || true
    $AWS cognito-idp admin-set-user-password \
        --user-pool-id "$POOL" --username admin@example.com \
        --password "$ADMIN_PW" --permanent >/dev/null 2>&1 || true
    echo "  Login        : $APP_URL  (admin@example.com / $ADMIN_PW)"
    echo "  Hosted UI    : $HOSTED"
else
    echo "  Login        : $APP_URL"
fi

echo ""
echo "  MonoFS break-glass token:"
echo "    aws secretsmanager get-secret-value --secret-id strata/monofs/token \\"
echo "      --profile $AWS_PROFILE --region $AWS_REGION --query SecretString --output text"
echo ""
echo "  The MonoFS encryption key is auto-generated by the stack."
echo "  To rotate it: aws secretsmanager put-secret-value --secret-id strata/monofs/encryption-key \\"
echo "    --secret-string \"\$(openssl rand -hex 32)\" --profile $AWS_PROFILE --region $AWS_REGION"
echo "    then force-new-deployment of the monofs services."
