FROM node:20-alpine

# Install postgresql-client for pg_isready health check in entrypoint
RUN apk add --no-cache postgresql-client

WORKDIR /app

# Install dependencies (cached layer)
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY src/ ./src/
COPY docker-entrypoint.sh ./

# Create logs dir and set permissions
RUN mkdir -p logs && chmod +x docker-entrypoint.sh

# Non-root user
RUN addgroup -S laitor && adduser -S laitor -G laitor \
    && chown -R laitor:laitor /app
USER laitor

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
