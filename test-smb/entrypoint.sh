#!/bin/sh
set -eu

password="${PALLET_TEST_PASSWORD:-pallet}"
printf '%s\n%s\n' "$password" "$password" | smbpasswd -a -s pallet >/dev/null

exec smbd --foreground --no-process-group --debug-stdout
