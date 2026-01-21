FROM node:20-alpine
RUN apk add --no-cache openssl

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN npm run build

ENV HOST=0.0.0.0
ENV PORT=8080

CMD ["npm", "run", "docker-start"]
