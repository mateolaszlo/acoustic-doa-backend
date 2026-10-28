#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$DIR"

if [ ! -f "$DIR/server.key" ] || [ ! -f "$DIR/server.cert" ]; then
  echo "Generating local self-signed TLS certificates for development..."
  (
    cd "$DIR"
    openssl req -nodes -new -x509 \
      -keyout "server.key" \
      -out "server.cert" \
      -days 365 \
      -subj "//CN=localhost/O=Acoustic DOA/C=SI"
  )
  echo "Certificates created at $DIR/server.key and $DIR/server.cert"
else
  echo "Certificates already exist."
fi