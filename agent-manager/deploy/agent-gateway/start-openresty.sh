#!/bin/sh
set -eu

: "${PLATFORM_API:?PLATFORM_API is required}"
PLATFORM_PUBLIC_URL="${PLATFORM_PUBLIC_URL:-}"

if printf '%s' "$PLATFORM_API" | grep -q '[[:cntrl:]]'; then
  echo "PLATFORM_API must not contain control characters" >&2
  exit 1
fi
if printf '%s' "$PLATFORM_PUBLIC_URL" | grep -q '[[:cntrl:][:space:]"\\]'; then
  echo "PLATFORM_PUBLIC_URL must not contain control characters, spaces, quotes, or backslashes" >&2
  exit 1
fi
if [ -n "$PLATFORM_PUBLIC_URL" ]; then
  case "$PLATFORM_PUBLIC_URL" in
    http://*|https://*) ;;
    *)
      echo "PLATFORM_PUBLIC_URL must start with http:// or https://" >&2
      exit 1
      ;;
  esac
fi

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[\\&|]/\\&/g'
}

DNS_RESOLVER="$(awk '/^nameserver[[:space:]]+/ { print $2; exit }' /etc/resolv.conf)"
if [ -z "$DNS_RESOLVER" ]; then
  echo "No DNS resolver found in /etc/resolv.conf" >&2
  exit 1
fi
if ! printf '%s' "$DNS_RESOLVER" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
  echo "DNS resolver must be an IPv4 address" >&2
  exit 1
fi

TLS_LISTEN=""
TLS_CERTIFICATE=""
if [ -s /etc/openclaw-agent-gateway/tls/tls.crt ] && [ -s /etc/openclaw-agent-gateway/tls/tls.key ]; then
  TLS_LISTEN="listen 8443 ssl;"
  TLS_CERTIFICATE="ssl_certificate /etc/openclaw-agent-gateway/tls/tls.crt; ssl_certificate_key /etc/openclaw-agent-gateway/tls/tls.key; ssl_protocols TLSv1.2 TLSv1.3;"
fi
PLATFORM_LOGIN_URL=""
if [ -n "$PLATFORM_PUBLIC_URL" ]; then
  PLATFORM_LOGIN_URL="${PLATFORM_PUBLIC_URL%/}/login"
fi

sed \
  -e "s|__DNS_RESOLVER__|$(escape_sed_replacement "$DNS_RESOLVER")|g" \
  -e "s|__PLATFORM_API__|$(escape_sed_replacement "$PLATFORM_API")|g" \
  -e "s|__PLATFORM_LOGIN_URL__|$(escape_sed_replacement "$PLATFORM_LOGIN_URL")|g" \
  -e "s|__TLS_LISTEN__|$(escape_sed_replacement "$TLS_LISTEN")|g" \
  -e "s|__TLS_CERTIFICATE__|$(escape_sed_replacement "$TLS_CERTIFICATE")|g" \
  /etc/openclaw-agent-gateway/openresty.conf.template \
  > /usr/local/openresty/nginx/conf/nginx.conf

exec openresty -g 'daemon off;'
