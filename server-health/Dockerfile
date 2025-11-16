FROM node:22-alpine

# Install docker CLI for container inspection
RUN apk add --no-cache docker-cli curl

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (needed for build)
RUN npm ci

# Copy source files and build configs
COPY tsconfig*.json ./
COPY vite.config.ts ./
COPY tsup.config.ts ./
COPY eslint.config.ts ./
COPY health-server.ts ./
COPY lib ./lib
COPY src ./src

# Build the application
RUN npm run build

# Remove devDependencies to reduce image size
RUN npm ci --omit=dev

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

CMD ["node", "dist/server/health-server.js"]
