FROM alpine:3.22

RUN apk add --no-cache openssh \
  && adduser -D -h /home/pallet -s /bin/ash pallet \
  && mkdir -p /etc/ssh/host-keys /run/sshd /home/pallet/upload \
  && chown -R pallet:pallet /home/pallet

COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/bin/test-server-entrypoint
COPY fixtures/ /home/pallet/

RUN chmod 0755 /usr/local/bin/test-server-entrypoint \
  && chown -R pallet:pallet /home/pallet

EXPOSE 22

ENTRYPOINT ["/usr/local/bin/test-server-entrypoint"]
