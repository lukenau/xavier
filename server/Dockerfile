# hub-api — the FastAPI server.
# Binds 0.0.0.0 INSIDE the container; docker-compose.yml publishes it on 127.0.0.1
# only, so the host port is reachable from this machine alone.
FROM python:3.12-slim

COPY requirements.txt /opt/hub-api/requirements.txt
RUN pip install --no-cache-dir -r /opt/hub-api/requirements.txt

COPY app.py ha_actions.py files.py hub_calendar.py hub_tz.py webauthn_gate.py devicekeys.py pair_local.py pair_cli.py /opt/hub-api/
COPY chat/ /opt/hub-api/chat/

# Non-root. The uid must own the host data dir mounted at /data (install.sh keeps
# HUB_UID in step with it), or writes to the database and key stores get EACCES.
ARG HUB_UID=1000
RUN useradd --uid "${HUB_UID}" --create-home hubapi
USER hubapi
WORKDIR /opt/hub-api

# Single worker is load-bearing: the WebAuthn challenge cache is in-process.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8090"]
