#!/usr/bin/env bash
# docker.sh — Container lifecycle: start, stop, wait-for-ready

# ── Network ─────────────────────────────────────────────────────────────────

ensure_network() {
  if ! docker network inspect "$DOCKER_NETWORK" &>/dev/null; then
    log "Creating Docker network: $DOCKER_NETWORK"
    docker network create "$DOCKER_NETWORK" >/dev/null
  fi
}

# ── Start containers ────────────────────────────────────────────────────────

start_es() {
  local id="$1" port="$2"
  local container="sb-${id}-es"

  log "Starting ES container: $container on port $port"
  docker run -d \
    --name "$container" \
    --network "$DOCKER_NETWORK" \
    -p "${port}:9200" \
    -e "discovery.type=single-node" \
    -e "xpack.security.enabled=true" \
    -e "xpack.security.http.ssl.enabled=false" \
    -e "xpack.security.transport.ssl.enabled=false" \
    -e "ELASTIC_PASSWORD=${ELASTIC_PASSWORD}" \
    -e "ES_JAVA_OPTS=-Xms${ES_HEAP} -Xmx${ES_HEAP}" \
    -e "cluster.name=sb-${id}" \
    "$ES_IMAGE" >/dev/null

  echo "$container"
}

start_kibana() {
  local id="$1" kb_port="$2" es_container="$3"
  local container="sb-${id}-kb"

  log "Starting Kibana container: $container on port $kb_port"
  docker run -d \
    --name "$container" \
    --network "$DOCKER_NETWORK" \
    -p "${kb_port}:5601" \
    -e "ELASTICSEARCH_HOSTS=http://${es_container}:9200" \
    -e "ELASTICSEARCH_USERNAME=kibana_system" \
    -e "ELASTICSEARCH_PASSWORD=${ELASTIC_PASSWORD}" \
    -e "XPACK_SECURITY_ENABLED=true" \
    "$KIBANA_IMAGE" >/dev/null

  echo "$container"
}

# ── Wait for readiness ──────────────────────────────────────────────────────

wait_for_es() {
  local port="$1" max_wait="${2:-120}"
  log "Waiting for ES on port $port (max ${max_wait}s)..."

  local elapsed=0
  while (( elapsed < max_wait )); do
    if es_curl "$port" GET "/_cluster/health" 2>/dev/null | jq -e '.status' &>/dev/null; then
      log "ES is ready on port $port"
      return 0
    fi
    sleep 2
    ((elapsed += 2))
  done

  die "ES failed to start within ${max_wait}s on port $port"
}

wait_for_kibana() {
  local port="$1" max_wait="${2:-180}"
  log "Waiting for Kibana on port $port (max ${max_wait}s)..."

  local elapsed=0
  while (( elapsed < max_wait )); do
    local status
    status=$(curl -s -o /dev/null -w '%{http_code}' \
      -u "elastic:${ELASTIC_PASSWORD}" \
      "http://localhost:${port}/api/status" 2>/dev/null) || true
    if [[ "$status" == "200" ]]; then
      log "Kibana is ready on port $port"
      return 0
    fi
    sleep 3
    ((elapsed += 3))
  done

  die "Kibana failed to start within ${max_wait}s on port $port"
}

# ── Write encryption keys to kibana.yml ─────────────────────────────────────

write_kibana_encryption_keys() {
  local container="$1"
  log "Writing encryption keys to kibana.yml in $container"

  docker exec "$container" bash -c "cat >> /usr/share/kibana/config/kibana.yml <<'YAML'

# Encryption keys for saved objects (required for Agent Builder connectors)
xpack.encryptedSavedObjects.encryptionKey: \"${KIBANA_ENCRYPTION_KEY}\"
xpack.security.encryptionKey: \"${KIBANA_ENCRYPTION_KEY}\"
xpack.reporting.encryptionKey: \"${KIBANA_ENCRYPTION_KEY}\"
YAML"

  log "Restarting Kibana container: $container"
  docker restart "$container" >/dev/null
}

# ── Stop / remove containers ───────────────────────────────────────────────

stop_sandbox() {
  local es_container="$1" kb_container="$2"
  log "Removing containers: $es_container, $kb_container"
  docker rm -f "$es_container" "$kb_container" 2>/dev/null || true
}
