#!/usr/bin/env bash
# Verify cache behavior across the three paths for every origin case.
#
#   WORKER_URL  e.g. https://study-cf-workers-cache.<acct>.workers.dev
#   CDN_URL     e.g. https://cache-compare.syumai.dev
#   AUTH_TOKEN  optional bearer token for the auth-* cases
#   SLEEP       seconds between the miss and hit probes (default 1)
#
# For each (path, case) the script sends two requests to the same unique URL
# and reports the cache's own status header plus whether the two responses
# share an X-Origin-Id (i.e. the second came from a stored copy rather than
# a fresh origin fetch).
set -u

WORKER_URL=${WORKER_URL:?set WORKER_URL}
CDN_URL=${CDN_URL:-}
SLEEP=${SLEEP:-1}
CASES=${CASES:-explicit expires heuristic nostore private set-cookie}
AUTH_TOKEN=${AUTH_TOKEN:-}
RUN=${RUN:-$(date +%s)}

req() { # url -> "<x-origin-id>|<cache-status>|<put-error>"
  local url=$1
  curl -s -D /tmp/vh.$$ -o /tmp/vb.$$ "${extra[@]+"${extra[@]}"}" "$url"
  local oid cs pe
  oid=$(tr -d '\r' < /tmp/vh.$$ | awk -F': ' 'tolower($1)=="x-origin-id"{print $2}')
  cs=$(tr -d '\r' < /tmp/vh.$$ | awk -F': ' 'tolower($1)=="x-workers-cache"{print $2}')
  [ -z "$cs" ] && cs=$(tr -d '\r' < /tmp/vh.$$ | awk -F': ' 'tolower($1)=="cf-cache-status"{print $2}')
  pe=$(tr -d '\r' < /tmp/vh.$$ | awk -F': ' 'tolower($1)=="x-cache-put-error"{print $2}')
  printf '%s|%s|%s' "${oid:-?}" "${cs:--}" "${pe:--}"
}

extra=()
[ -n "$AUTH_TOKEN" ] && extra=(-H "Authorization: Bearer $AUTH_TOKEN")

printf '%-14s %-26s %-26s %-26s\n' case cache-api passthrough cdn-proxy
for c in $CASES; do
  row=("$c")
  for path in "$WORKER_URL/cache-api/api/respond" "$WORKER_URL/passthrough/api/respond" "${CDN_URL:+$CDN_URL/api/respond}"; do
    [ -z "$path" ] && { row+=("n/a"); continue; }
    r1=$(req "$path?case=$c&run=$RUN")
    sleep "$SLEEP"
    r2=$(req "$path?case=$c&run=$RUN")
    id1=${r1%%|*}; rest=${r1#*|}; cs1=${rest%%|*}
    id2=${r2%%|*}; rest=${r2#*|}; cs2=${rest%%|*}; pe2=${rest#*|}
    verdict="fresh"
    { [ "$cs2" = "HIT" ] || [ "$id1" = "$id2" ]; } && verdict="CACHED"
    cell="$cs1->$cs2/$verdict"
    [ "$pe2" != "-" ] && cell="$cell(put!)"
    row+=("$cell")
  done
  printf '%-14s %-26s %-26s %-26s\n' "${row[@]}"
done
rm -f /tmp/vh.$$ /tmp/vb.$$
