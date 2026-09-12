FROM alpine:3.22

RUN apk add --no-cache openssh openssl pure-ftpd iproute2 iproute2-tc \
  && adduser -D -h /home/pallet -s /bin/ash pallet \
  && mkdir -p /etc/ssh/host-keys /etc/pure-ftpd/certs /run/sshd /home/pallet/upload \
  && chown -R pallet:pallet /home/pallet

COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/bin/test-server-entrypoint
COPY network.sh /usr/local/bin/test-server-network
COPY fixtures/ /home/pallet/

RUN chmod 0755 /usr/local/bin/test-server-entrypoint /usr/local/bin/test-server-network \
  && chown -R pallet:pallet /home/pallet

EXPOSE 21 22 30000-30009 30100-30109

ENTRYPOINT ["/usr/local/bin/test-server-entrypoint"]
