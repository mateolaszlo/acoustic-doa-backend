#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$DIR"

FORCE=false
if [ "${1:-}" = "--force" ]; then
  FORCE=true
fi

NEEDS_REGEN=false
if [ "$FORCE" = true ] || [ ! -f "$DIR/server.key" ] || [ ! -f "$DIR/server.cert" ]; then
  NEEDS_REGEN=true
elif ! openssl x509 -in "$DIR/server.cert" -noout -ext subjectAltName 2>/dev/null | grep -q "DNS:localhost"; then
  echo "Existing certificate lacks SAN extensions; regenerating..."
  NEEDS_REGEN=true
fi

if [ "$NEEDS_REGEN" = true ]; then
  echo "Generating local self-signed SAN TLS certificates for development..."
  (
    cd "$DIR"
    MSYS_NO_PATHCONV=1 openssl req -nodes -new -x509 \
      -keyout "server.key" \
      -out "server.cert" \
      -days 365 \
      -subj "/C=SI/O=Acoustic DOA/CN=localhost" \
      -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
      -addext "basicConstraints=CA:FALSE" \
      -addext "keyUsage=digitalSignature,keyEncipherment" \
      -addext "extendedKeyUsage=serverAuth"
  )
  echo "Certificates created at $DIR/server.key and $DIR/server.cert"
else
  echo "Certificates already exist with SAN extensions."
fi
