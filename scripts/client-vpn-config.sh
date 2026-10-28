#!/usr/bin/env bash
# Export an AWS Client VPN .ovpn profile and embed the generated client cert.
set -euo pipefail

PROFILE="${AWS_PROFILE:-default}"
REGION="${AWS_REGION:-us-east-1}"
ENDPOINT_ID=""
CERT_DIR=""
OUT_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --endpoint-id) ENDPOINT_ID="$2"; shift 2 ;;
    --cert-dir) CERT_DIR="$2"; shift 2 ;;
    --out) OUT_FILE="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$ENDPOINT_ID" && -n "$CERT_DIR" && -n "$OUT_FILE" ]] || {
  echo "usage: $0 --endpoint-id <id> --cert-dir <dir> --out <file>" >&2
  exit 2
}

for f in "$CERT_DIR/client.crt" "$CERT_DIR/client.key"; do
  [[ -f "$f" ]] || { echo "missing $f (run client-vpn-certs.sh first)" >&2; exit 1; }
done

mkdir -p "$(dirname "$OUT_FILE")"
umask 077
aws --profile "$PROFILE" --region "$REGION" ec2 export-client-vpn-client-configuration \
  --client-vpn-endpoint-id "$ENDPOINT_ID" \
  --query ClientConfiguration --output text >"$OUT_FILE"

# export-client-vpn-client-configuration returns the OpenVPN body; append the
# client identity expected by mutual TLS.
{
  echo
  echo "<cert>"
  cat "$CERT_DIR/client.crt"
  echo "</cert>"
  echo "<key>"
  cat "$CERT_DIR/client.key"
  echo "</key>"
} >>"$OUT_FILE"

chmod 600 "$OUT_FILE"
echo "wrote $OUT_FILE"
