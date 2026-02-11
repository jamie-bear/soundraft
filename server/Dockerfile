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

# Install server dependencies
COPY package*.json ./
RUN npm ci --production

# Copy server source
COPY . .

# Copy built frontend from stage 1
COPY --from=frontend /app/dist ./public

EXPOSE 8080
CMD ["node", "index.js"]
