# Stage 1: Build the React frontend
# 'client-build' is an additional context defined in docker-compose.yml
# pointing to the ./client directory
FROM node:18-alpine AS frontend
WORKDIR /app
COPY --from=client-build package*.json ./
RUN npm ci
COPY --from=client-build . .
RUN npm run build
# Output: /app/dist/

# Stage 2: Production API server
FROM node:18-alpine
WORKDIR /app

# V14: Create non-root user for running the application
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

# Install server dependencies
COPY package*.json ./
RUN npm ci --production

# Copy server source
COPY . .

# Copy built frontend from stage 1
COPY --from=frontend /app/dist ./public

# V14: Run as non-root user
USER nodejs

EXPOSE 8080
CMD ["node", "index.js"]
