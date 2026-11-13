#!/bin/sh
# Re-flash only the poster filesystem.
# Usage: ./update_posters.sh /dev/ttyACM0
set -e
if [ -z "$1" ]; then
  echo "usage: $0 <serial-port>"
  exit 1
fi
cd "$(dirname "$0")/.."
idf.py -p "$1" storage-flash
