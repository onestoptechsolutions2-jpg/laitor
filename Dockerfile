FROM node:20-alpine

# netcat for port-readiness check in entrypoint
RUN apk add --no-cache netcat-openbsd

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src/ ./src/
COPY public/ ./public/
COPY docker-entrypoint.sh ./

RUN mkdir -p logs public && chmod +x docker-entrypoint.sh

RUN addgroup -S laitor && adduser -S laitor -G laitor \
    && chown -R laitor:laitor /app
USER laitor

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD wget -qO- http://localhost:3000/health || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
