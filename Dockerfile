FROM node:20-alpine

RUN apk add --no-cache openssl

WORKDIR /app

COPY package.json package-lock.json* ./

# Install ALL dependencies (including devDependencies) so the build can succeed
RUN npm ci

COPY . .

# Build the application
RUN npm run build

# Optional: Prune dev dependencies after build to save space (commented out for safety/speed)
# RUN npm prune --production

ENV HOST=0.0.0.0
ENV PORT=8080
ENV NODE_ENV=production
ENV SESSION_DB_PATH=/tmp/shopify_sessions.sqlite

# Create a script to handle startup
RUN echo '#!/bin/sh' > /app/startup.sh && \
    echo 'echo "Starting application with NODE_ENV=$NODE_ENV"' >> /app/startup.sh && \
    echo 'echo "Session DB Path: $SESSION_DB_PATH"' >> /app/startup.sh && \
    echo '# Verify write permissions to /tmp' >> /app/startup.sh && \
    echo 'touch /tmp/test_write || echo "ERROR: Cannot write to /tmp"' >> /app/startup.sh && \
    echo 'rm /tmp/test_write' >> /app/startup.sh && \
    echo '# Start the application' >> /app/startup.sh && \
    echo 'exec npm run docker-start' >> /app/startup.sh && \
    chmod +x /app/startup.sh

CMD ["/app/startup.sh"]
