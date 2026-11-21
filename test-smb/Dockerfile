FROM alpine:3.22

RUN apk add --no-cache samba \
  && adduser -D -H -s /sbin/nologin pallet \
  && mkdir -p /srv/pallet \
  && chown pallet:pallet /srv/pallet

COPY smb.conf /etc/samba/smb.conf
COPY entrypoint.sh /usr/local/bin/test-smb-entrypoint
RUN chmod 0755 /usr/local/bin/test-smb-entrypoint

EXPOSE 445

ENTRYPOINT ["/usr/local/bin/test-smb-entrypoint"]
