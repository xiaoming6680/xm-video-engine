#!/bin/bash
# args: key path url
# [xm] e.g. while IFS=$'\t' read -r k p u; do bash download_vcsl.sh "$k" "$p" "$u"; done < vcsl_list.tsv
# downloads into ${VCSL_RAW:-/tmp/vcsl_raw} (Git Bash /tmp = the Windows temp folder)
RAW="${VCSL_RAW:-/tmp/vcsl_raw}"
key="$1"; path="$2"; url="$3"
fn=$(basename "$path")
mkdir -p "$RAW/$key"
out="$RAW/$key/$fn"
if [ ! -s "$out" ]; then
  curl -s -f -L --retry 3 -m 300 -o "$out" "$url" || echo "FAIL $url"
fi
