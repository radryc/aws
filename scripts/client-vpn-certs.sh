#!/usr/bin/env bash
# Generate and import the mutual-TLS certificates for AWS Client VPN.
#
# Outputs:
#   <out-dir>/ca.crt, ca.key
#   <out-dir>/server.crt, server.key
#   <out-dir>/client.crt, client.key
#   <out-dir>/certs.env   (VPN_SERVER_CERT_ARN, VPN_CLIENT_ROOT_CERT_ARN)
#
# The private keys stay in <out-dir> and are never printed.
set -euo pipefail

PROFILE="${AWS_PROFILE:-default}"
REGION="${AWS_REGION:-us-east-1}"
OUT_DIR=""
FORCE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --force) FORCE=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$OUT_DIR" ]] || { echo "--out-dir is required" >&2; exit 2; }
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }
command -v aws >/dev/null || { echo "aws is required" >&2; exit 1; }

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"
ENV_FILE="$OUT_DIR/certs.env"

if [[ -f "$ENV_FILE" && "$FORCE" != "true" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  if [[ -n "${VPN_SERVER_CERT_ARN:-}" && -n "${VPN_CLIENT_ROOT_CERT_ARN:-}" ]]; then
    echo "using existing client VPN certificates from $ENV_FILE"
    exit 0
  fi
fi

umask 077
OPENSSL_CNF="$OUT_DIR/openssl.cnf"
cat >"$OPENSSL_CNF" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = v3_ca
prompt = no

[dn]
CN = strata-client-vpn-ca

[v3_ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash

[server_ext]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:vpn.strata.local

[client_ext]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = clientAuth
EOF

if [[ ! -f "$OUT_DIR/ca.key" || "$FORCE" == "true" ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$OUT_DIR/ca.key" -out "$OUT_DIR/ca.crt" \
    -config "$OPENSSL_CNF" -extensions v3_ca >/dev/null 2>&1
fi

if [[ ! -f "$OUT_DIR/server.key" || "$FORCE" == "true" ]]; then
  openssl req -newkey rsa:2048 -nodes \
    -keyout "$OUT_DIR/server.key" -out "$OUT_DIR/server.csr" \
    -subj "/CN=vpn.strata.local" >/dev/null 2>&1
  openssl x509 -req -in "$OUT_DIR/server.csr" -CA "$OUT_DIR/ca.crt" -CAkey "$OUT_DIR/ca.key" \
    -CAcreateserial -out "$OUT_DIR/server.crt" -days 3650 \
    -extfile "$OPENSSL_CNF" -extensions server_ext >/dev/null 2>&1
fi

if [[ ! -f "$OUT_DIR/client.key" || "$FORCE" == "true" ]]; then
  openssl req -newkey rsa:2048 -nodes \
    -keyout "$OUT_DIR/client.key" -out "$OUT_DIR/client.csr" \
    -subj "/CN=strata-demo-client" >/dev/null 2>&1
  openssl x509 -req -in "$OUT_DIR/client.csr" -CA "$OUT_DIR/ca.crt" -CAkey "$OUT_DIR/ca.key" \
    -CAcreateserial -out "$OUT_DIR/client.crt" -days 3650 \
    -extfile "$OPENSSL_CNF" -extensions client_ext >/dev/null 2>&1
fi

echo "importing server certificate into ACM ($REGION)..."
SERVER_ARN="$(aws --profile "$PROFILE" --region "$REGION" acm import-certificate \
  --certificate "fileb://$OUT_DIR/server.crt" \
  --private-key "fileb://$OUT_DIR/server.key" \
  --certificate-chain "fileb://$OUT_DIR/ca.crt" \
  --query CertificateArn --output text)"

echo "importing client root CA into ACM ($REGION)..."
CLIENT_CA_ARN="$(aws --profile "$PROFILE" --region "$REGION" acm import-certificate \
  --certificate "fileb://$OUT_DIR/ca.crt" \
  --private-key "fileb://$OUT_DIR/ca.key" \
  --query CertificateArn --output text)"

cat >"$ENV_FILE" <<EOF
VPN_SERVER_CERT_ARN=$SERVER_ARN
VPN_CLIENT_ROOT_CERT_ARN=$CLIENT_CA_ARN
EOF
chmod 600 "$ENV_FILE"

echo "client VPN certificates ready"
echo "  server: $SERVER_ARN"
echo "  client CA: $CLIENT_CA_ARN"
