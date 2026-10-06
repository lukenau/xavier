# hub-bridge — the only component that may hold privileged access.
#
# Base is the official Docker CLI image so `docker exec` is available in the
# default exec mode; python3 is added for the stdlib HTTP server. No pip deps —
# bridge.py is stdlib-only (PyYAML is used only INSIDE the agent container, by the
# config-dump script, never here).
FROM docker:27-cli

RUN apk add --no-cache python3

# A non-root user for LOCAL exec mode (BRIDGE_EXEC=local), where no docker socket
# is needed. The image runs as this user BY DEFAULT.
RUN addgroup -S bridge && adduser -S -G bridge bridge

COPY bridge.py /opt/hub-bridge/bridge.py

EXPOSE 8091
USER bridge
CMD ["python3", "/opt/hub-bridge/bridge.py"]

# ─────────────────────────────────────────────────────────────────────────────
# DOCKER-SOCKET ACCESS IS ROOT-EQUIVALENT ON THE HOST.
#
# In the default exec mode this container must reach /var/run/docker.sock to run
# `docker exec` into the agent container. That socket is owned root:docker and
# grants full control of the Docker daemon — anyone who can use it can start a
# privileged container and own the host. For that reason the docker-socket
# deployment runs this image as root (the compose `bridge` profile sets
# `user: "0:0"` and mounts the socket); the shared bearer key and the strict
# allowlist are what keep that privilege behind a narrow door.
#
# If you run Hermes on the SAME host or in the SAME container, prefer
# BRIDGE_EXEC=local: no docker socket, and this image's default non-root user
# applies. See README.md.
# ─────────────────────────────────────────────────────────────────────────────
