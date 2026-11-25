#!/usr/bin/env bash
# Issue a Let's Encrypt certificate for game.realkawaiibaka.com.
#
#   ./deploy/issue-cert.sh manual-init    # print the TXT record; add it in Aliyun
#   ./deploy/issue-cert.sh manual-finish  # validate the TXT and install
#   ./deploy/issue-cert.sh webroot        # needs port 80 -> .102:80
#   ./deploy/issue-cert.sh aliyun         # needs Ali_Key / Ali_Secret
#
# Certificates are written to deploy/certs/ (gitignored) and mounted into
# the Caddy container. Restart caddy after renewal.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOMAIN="${DOMAIN:-game.realkawaiibaka.com}"
ACME_HOME="${ACME_HOME:-$ROOT/.acme}"
ACME="$ACME_HOME/acme.sh"
CERT_DIR="${CERT_DIR:-$ROOT/deploy/certs}"
WEBROOT="${WEBROOT:-$ROOT/deploy/acme-webroot}"
MODE="${1:-}"

if [[ ! -x "$ACME" ]]; then
  mkdir -p "$ACME_HOME"
  curl -fsSL --max-time 60 \
    https://raw.githubusercontent.com/acmesh-official/acme.sh/master/acme.sh \
    -o "$ACME"
  chmod +x "$ACME"
fi
mkdir -p "$CERT_DIR"

issue() {
  "$ACME" --home "$ACME_HOME" --issue \
    --server letsencrypt --keylength ec-256 -d "$DOMAIN" "$@"
}

install_cert() {
  "$ACME" --home "$ACME_HOME" --install-cert -d "$DOMAIN" --ecc \
    --key-file "$CERT_DIR/key.pem" \
    --fullchain-file "$CERT_DIR/fullchain.pem"
  chmod 600 "$CERT_DIR/key.pem"
  chmod 644 "$CERT_DIR/fullchain.pem"
  echo "certificate installed in $CERT_DIR"
}

case "$MODE" in
  manual-init)
    issue --dns --yes-I-know-dns-manual-mode-enough-go-ahead-please
    echo
    echo "Add the TXT record above in Aliyun DNS, wait for it to resolve,"
    echo "then run: $0 manual-finish"
    ;;
  manual-finish)
    if ! "$ACME" --home "$ACME_HOME" --renew -d "$DOMAIN" --ecc --server letsencrypt \
      --yes-I-know-dns-manual-mode-enough-go-ahead-please; then
      echo "renew skipped or failed; installing an existing certificate if present"
    fi
    install_cert
    ;;
  aliyun)
    : "${Ali_Key:?set Ali_Key to an Aliyun RAM AccessKey with DNS permissions}"
    : "${Ali_Secret:?set Ali_Secret}"
    issue --dns dns_ali
    install_cert
    ;;
  webroot)
    if [[ ! -d "$WEBROOT" ]]; then
      echo "webroot not found: $WEBROOT" >&2
      exit 1
    fi
    issue --webroot "$WEBROOT"
    install_cert
    ;;
  *)
    sed -n '2,12p' "$0"
    exit 1
    ;;
esac
