
FROM node:20
# Switch to Debian-based Node image (more stable than Alpine for some native deps)

WORKDIR /app
COPY package.json package-lock.json* ./

# Install ALL dependencies (fresh install)
RUN npm install

COPY . .

# Create a dummy .env for build time (Vite sometimes needs this)
RUN echo "SHOPIFY_API_KEY=dummy_key_for_build" > .env
RUN echo "SHOPIFY_API_SECRET=dummy_secret" >> .env
RUN echo "SCOPES=read_products" >> .env
RUN echo "SHOPIFY_APP_URL=https://dummy-url.com" >> .env

# Build the app (with increased memory + envs)
RUN NODE_OPTIONS="--max-old-space-size=4096" npm run build

# Remove the dummy .env so Cloud Run environment take precedence
RUN rm .env

ENV HOST=0.0.0.0
ENV PORT=8080
ENV NODE_ENV=production

CMD ["npm", "run", "docker-start"]
