# Stage 1: Build the React frontend
FROM node:24-alpine AS frontend
WORKDIR /app
COPY client/package*.json ./
RUN npm ci
COPY client/ .
RUN npm run build
# Output: /app/dist/

# Stage 2: Production API server
FROM node:24-alpine
WORKDIR /app

# Create non-root user for running the application
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

# Install server dependencies
COPY server/package*.json ./
RUN npm ci --production

# Copy server source
COPY server/ .

# Copy built frontend from stage 1
COPY --from=frontend /app/dist ./public

# Run as non-root user
USER nodejs

EXPOSE 8080
CMD ["node", "index.js"]
