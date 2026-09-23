#!/usr/bin/env bash
# Verify cache behavior across the cache paths for every origin case.
#
#   WORKER_URL  e.g. https://study-cf-workers-cache.<acct>.workers.dev
#   CDN_URL     e.g. https://cache-compare.syumai.dev
#   AUTH_TOKEN  bearer token sent on every request (for auth-* cases)
#   PROBES      number of requests per (path, case) (default 8)
#   SLEEP       seconds between probes (default 1)
#
# Each (path, case) uses a fresh per-run URL so the first probe always misses.
# Caches are colo-local, so probes deliberately span multiple colos: a case is
# "cached" only if later probes come back HIT in a colo that already stored it.
set -u

WORKER_URL=${WORKER_URL:?set WORKER_URL}
CDN_URL=${CDN_URL:-}
PROBES=${PROBES:-8}
SLEEP=${SLEEP:-1}
CASES=${CASES:-explicit expires heuristic swr nostore private set-cookie auth-public}
AUTH_TOKEN=${AUTH_TOKEN:-}
RUN=${RUN:-$(date +%s)}

req() { # url -> "<x-origin-id>|<cache-status>|<put-error>|<colo>"
  local url=$1
  curl -s -D /tmp/vh.$$ -o /tmp/vb.$$ "${extra[@]+"${extra[@]}"}" "$url"
  local h oid cs pe ray
  h=$(tr -d '\r' < /tmp/vh.$$)
  oid=$(printf '%s' "$h" | awk -F': ' 'tolower($1)=="x-origin-id"{print $2}')
  cs=$(printf '%s' "$h" | awk -F': ' 'tolower($1)=="x-workers-cache"{print $2}')
  [ -z "$cs" ] && cs=$(printf '%s' "$h" | awk -F': ' 'tolower($1)=="cf-cache-status"{print $2}')
  pe=$(printf '%s' "$h" | awk -F': ' 'tolower($1)=="x-cache-put-error"{print $2}')
  ray=$(printf '%s' "$h" | awk -F': ' 'tolower($1)=="cf-ray"{print $2}' | sed 's/.*-//')
  printf '%s|%s|%s|%s' "${oid:-?}" "${cs:--}" "${pe:--}" "${ray:-?}"
}

extra=()
[ -n "$AUTH_TOKEN" ] && extra=(-H "Authorization: Bearer $AUTH_TOKEN")

paths=("$WORKER_URL/api/respond" "$WORKER_URL/cache-api/api/respond" "$WORKER_URL/cache-override/api/respond" "$WORKER_URL/passthrough/api/respond" "${CDN_URL:+$CDN_URL/api/respond}")
labels=(workers-cache cache-api cache-override passthrough cdn-proxy)

printf '%-14s' case
for l in "${labels[@]}"; do printf ' %-18s' "$l"; done
printf '\n'

for c in $CASES; do
  printf '%-14s' "$c"
  for pi in "${!paths[@]}"; do
    path=${paths[$pi]}
    if [ -z "$path" ]; then printf ' %-18s' "n/a"; continue; fi
    hits=0; colos=""; errs=0
    for i in $(seq "$PROBES"); do
      r=$(req "$path?case=$c&run=$RUN")
      cs=$(printf '%s' "$r" | cut -d'|' -f2)
      pe=$(printf '%s' "$r" | cut -d'|' -f3)
      ray=$(printf '%s' "$r" | cut -d'|' -f4)
      { [ "$cs" = "HIT" ] || [ "$cs" = "UPDATING" ]; } && hits=$((hits+1))
      [ "$pe" != "-" ] && errs=$((errs+1))
      case ",$colos," in *",$ray,"*) ;; *) colos="${colos:+$colos,}$ray";; esac
      sleep "$SLEEP"
    done
    cell="$hits/$PROBES hits"
    [ "$errs" -gt 0 ] && cell="$cell,${errs}put!"
    cell="$cell@$colos"
    printf ' %-18s' "$cell"
  done
  printf '\n'
done
rm -f /tmp/vh.$$ /tmp/vb.$$
