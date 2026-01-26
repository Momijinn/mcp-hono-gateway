FROM node:25-bookworm-slim AS base
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/* \
  && curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh

# --- Dev (hot reload) ---
FROM base AS dev
ENV NODE_ENV=development

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev"]

# --- Build (TypeScript -> dist) ---
FROM base AS build
ENV NODE_ENV=development

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json biome.json ./
COPY src ./src
RUN npm run build

# --- Production runtime ---
FROM base AS prod
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
