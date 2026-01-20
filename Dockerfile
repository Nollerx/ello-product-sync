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

CMD ["npm", "run", "docker-start"]
