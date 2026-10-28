FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT_HTTP=3000
ENV PORT_HTTPS=3443

# Install dependencies including build tools for better-sqlite3 native compilation
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --only=production

COPY app.js ./
COPY bin/ ./bin/
COPY routes/ ./routes/
COPY utils/ ./utils/
COPY views/ ./views/
COPY public/ ./public/
COPY db/ ./db/

EXPOSE 3000 3443
CMD ["node", "./bin/www"]
