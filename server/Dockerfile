# Stage 1: Build the React frontend
# 'client-build' is an additional context defined in docker-compose.yml
# pointing to the ./client directory
FROM node:24-alpine AS frontend
WORKDIR /app
COPY --from=client-build package*.json ./
RUN npm ci
COPY --from=client-build . .
RUN npm run build
# Output: /app/dist/

# Stage 2: Production API server
FROM node:24-alpine
WORKDIR /app

# wget is used by the container health check.
RUN apk add --no-cache wget

# Create non-root user for running the application
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

# Install server dependencies
COPY package*.json ./
RUN npm ci --production && npm cache clean --force

# Copy server source
COPY . .

# Copy built frontend from stage 1
COPY --from=frontend /app/dist ./public

# Create temp upload directory
RUN mkdir -p /tmp/soundraft-uploads && chown nodejs:nodejs /tmp/soundraft-uploads

# Run as non-root user
USER nodejs

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget --spider -q http://localhost:8080/api/health || exit 1

LABEL org.opencontainers.image.title="SoundRaft" \
      org.opencontainers.image.description="Self-hosted audio versioning and sharing platform" \
      org.opencontainers.image.source="https://github.com/jamie-bear/soundraft"

CMD ["node", "index.js"]
