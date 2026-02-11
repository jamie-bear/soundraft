# Standalone client build (not used directly in production)
# Production builds happen via server/Dockerfile using additional_contexts
FROM node:18-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
# Output: /app/dist/
