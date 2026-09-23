#!/bin/sh
set -eu

# All controls live inside this container's network namespace. Redirect ingress
# through a veth pair so uploads are queued before entering the IP stack.
# This also works on Docker Desktop kernels without the optional IFB module.
device=eth0
incoming=pallet-up
receiver=pallet-rx
profile="${PALLET_TEST_NETWORK:-realistic}"

fail() {
  echo "Test network: $*" >&2
  exit 1
}

if [ "${1:-}" = status ]; then
  tc -s qdisc show dev "$device"
  if ip link show "$incoming" >/dev/null 2>&1; then
    tc -s qdisc show dev "$incoming"
    tc filter show dev "$device" parent ffff:
  fi
  exit 0
fi

case "$profile" in
  realistic) download=10000; upload=2000; delay=40; jitter=10; loss=0.1 ;;
  weak) download=1500; upload=500; delay=150; jitter=50; loss=2 ;;
  optimal) download=100000; upload=50000; delay=10; jitter=2; loss=0 ;;
  performant) download=1000000; upload=1000000; delay=1; jitter=0; loss=0 ;;
  offline) download=10000; upload=2000; delay=0; jitter=0; loss=100 ;;
  off) ;;
  *) fail "Unknown profile '$profile'. Use realistic, weak, optimal, performant, offline, or off." ;;
esac

if [ "$profile" != off ]; then
  if [ "$profile" != offline ]; then
    download="${PALLET_TEST_DOWNLOAD_KBIT:-$download}"
    upload="${PALLET_TEST_UPLOAD_KBIT:-$upload}"
    delay="${PALLET_TEST_DELAY_MS:-$delay}"
    jitter="${PALLET_TEST_JITTER_MS:-$jitter}"
    loss="${PALLET_TEST_LOSS_PERCENT:-$loss}"
  fi

  # Validate everything before altering an existing setup, including live edits.
  for value in "$download" "$upload" "$delay" "$jitter"; do
    case "$value" in ''|*[!0-9]*) fail "Rates, delay, and jitter must be whole numbers." ;; esac
    [ "${#value}" -le 7 ] || fail "Rates, delay, and jitter are too large."
  done
  [ "$download" -gt 0 ] && [ "$upload" -gt 0 ] || fail "Rates must be greater than zero."
  [ "$jitter" -le "$delay" ] || fail "Jitter cannot exceed the one-way delay."
  awk -v value="$loss" 'BEGIN { exit !(value ~ /^[0-9]+([.][0-9]+)?$/ && value >= 0 && value <= 100) }' \
    || fail "Loss must be a percentage between 0 and 100."
  [ "$(cat /proc/sys/net/ipv4/conf/all/rp_filter)" != 1 ] &&
    [ "$(cat /proc/sys/net/ipv4/conf/default/rp_filter)" != 1 ] \
    || fail "Strict reverse-path filtering prevents upload shaping. Use the supplied Compose sysctls."
fi

# A pristine interface has no removable root qdisc or ingress hook.
tc qdisc del dev "$device" root 2>/dev/null || true
tc qdisc del dev "$device" ingress 2>/dev/null || true
if ip link show "$incoming" >/dev/null 2>&1; then
  ip link delete "$incoming" || fail "Cannot remove the previous upload shaper."
fi

if [ "$profile" = off ]; then
  # Do not claim shaping is disabled if removing it failed (e.g. no NET_ADMIN).
  if tc qdisc show dev "$device" | grep -Eq 'netem|ingress'; then
    fail "Cannot disable shaping; check the container's NET_ADMIN capability."
  fi
  echo "Test network: off (unrestricted local connection)"
  exit 0
fi

apply_network() {
  # Keep the receiving MAC equal to eth0 so redirected IP packets are local.
  # ARP stays on eth0; only IP traffic takes the detour through the upload queue.
  ip link add "$incoming" type veth peer name "$receiver" &&
  ip link set "$incoming" up &&
  ip link set "$receiver" address "$(cat /sys/class/net/"$device"/address)" up &&
  tc qdisc add dev "$device" handle ffff: ingress &&
  tc filter add dev "$device" parent ffff: protocol ip pref 1 matchall \
    action mirred egress redirect dev "$incoming" &&
  tc filter add dev "$device" parent ffff: protocol ipv6 pref 2 matchall \
    action mirred egress redirect dev "$incoming" &&
  tc qdisc add dev "$incoming" root netem limit 1000 \
    delay "${delay}ms" "${jitter}ms" loss random "${loss}%" rate "${upload}kbit" &&
  tc qdisc add dev "$device" root netem limit 1000 \
    delay "${delay}ms" "${jitter}ms" loss random "${loss}%" rate "${download}kbit"
}

apply_network || fail "Cannot apply shaping. Docker needs NET_ADMIN and kernel support for netem/veth. Refusing to start an unrestricted server. Use PALLET_TEST_NETWORK=off only for an intentional unrestricted test."
echo "Test network: $profile; download ${download}kbit/s; upload ${upload}kbit/s; one-way delay ${delay}ms ± ${jitter}ms; loss ${loss}% per direction"
