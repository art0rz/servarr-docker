FROM node:22-alpine

# Install docker CLI for container inspection
RUN apk add --no-cache docker-cli curl

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy application files
COPY health-server.js .
COPY lib ./lib

# Add node user to docker group
# Default GID is 984, override with: docker compose build --build-arg DOCKER_GID=$(getent group docker | cut -d: -f3) health-server
ARG DOCKER_GID=984
RUN if getent group docker >/dev/null 2>&1; then delgroup docker; fi && \
    if getent group ${DOCKER_GID} >/dev/null 2>&1; then delgroup $(getent group ${DOCKER_GID} | cut -d: -f1); fi && \
    addgroup -g ${DOCKER_GID} docker && \
    addgroup node docker && \
    chown -R node:node /app

USER node

EXPOSE 3000

CMD ["node", "health-server.js"]
