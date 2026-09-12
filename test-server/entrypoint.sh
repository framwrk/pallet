#!/bin/sh
set -eu

/usr/local/bin/test-server-network

password="${PALLET_TEST_PASSWORD:-pallet}"
echo "pallet:${password}" | chpasswd

case "${PALLET_TEST_PROTOCOL:-sftp}" in
  sftp)
    if [ ! -f /etc/ssh/host-keys/ssh_host_ed25519_key ]; then
      ssh-keygen -q -t ed25519 -N "" -f /etc/ssh/host-keys/ssh_host_ed25519_key
    fi

    if [ ! -f /etc/ssh/host-keys/ssh_host_rsa_key ]; then
      ssh-keygen -q -t rsa -b 3072 -N "" -f /etc/ssh/host-keys/ssh_host_rsa_key
    fi

    exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
    ;;
  ftp)
    exec /usr/sbin/pure-ftpd \
      -A \
      -E \
      -H \
      -l unix \
      -p 30000:30009 \
      -P 127.0.0.1 \
      -S 0.0.0.0,21 \
      -Y 0
    ;;
  ftps)
    if [ ! -f /etc/pure-ftpd/certs/pure-ftpd.pem ]; then
      openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
        -subj "/CN=localhost/O=Pallet Local Test Server" \
        -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
        -keyout /etc/pure-ftpd/certs/localhost-key.pem \
        -out /etc/pure-ftpd/certs/localhost-cert.pem
      cat /etc/pure-ftpd/certs/localhost-cert.pem /etc/pure-ftpd/certs/localhost-key.pem \
        > /etc/pure-ftpd/certs/pure-ftpd.pem
      chmod 0600 /etc/pure-ftpd/certs/localhost-key.pem /etc/pure-ftpd/certs/pure-ftpd.pem
    fi
    exec /usr/sbin/pure-ftpd \
      -A \
      -E \
      -H \
      -l unix \
      -p 30100:30109 \
      -P 127.0.0.1 \
      -S 0.0.0.0,21 \
      -Y 2 \
      -2 /etc/pure-ftpd/certs/pure-ftpd.pem
    ;;
  *)
    echo "Unsupported PALLET_TEST_PROTOCOL: ${PALLET_TEST_PROTOCOL}" >&2
    exit 64
    ;;
esac
