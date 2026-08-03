# Real OpenSSH server for Pallet's SFTP integration tests (§8).
# Build context: tests/integration/docker
FROM alpine:3.22

RUN apk add --no-cache openssh && ssh-keygen -A

RUN adduser -D testuser \
  && echo 'testuser:testpass' | chpasswd \
  && mkdir -p /home/testuser/.ssh

COPY keys/test_ed25519.pub /home/testuser/.ssh/authorized_keys

# Fixtures the tests assert against: plain files, a subdir, dotfile,
# non-ASCII name, symlinks (valid + broken).
RUN mkdir -p /home/testuser/fixtures/subdir \
  && printf 'hello world\n' > /home/testuser/fixtures/hello.txt \
  && printf 'nested\n' > /home/testuser/fixtures/subdir/nested.txt \
  && printf 'secret\n' > /home/testuser/fixtures/.hidden \
  && printf 'unicode\n' > '/home/testuser/fixtures/naïve Dätei 文件.txt' \
  && ln -s subdir /home/testuser/fixtures/link-to-subdir \
  && ln -s hello.txt /home/testuser/fixtures/link-to-file \
  && ln -s missing-target /home/testuser/fixtures/broken-link \
  && chown -R testuser:testuser /home/testuser \
  && chmod 700 /home/testuser/.ssh \
  && chmod 600 /home/testuser/.ssh/authorized_keys

RUN printf '%s\n' \
  'PasswordAuthentication yes' \
  'PermitRootLogin no' \
  'AllowUsers testuser' \
  >> /etc/ssh/sshd_config

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
