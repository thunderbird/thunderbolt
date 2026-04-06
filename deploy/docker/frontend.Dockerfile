# Stage 1: Build frontend static files
FROM oven/bun:latest AS build

WORKDIR /app

# Install deps first for layer caching
COPY package.json bun.lock ./
COPY shared ./shared
RUN bun install --frozen-lockfile

# Copy frontend source
COPY src ./src
COPY public ./public
COPY index.html ./
COPY vite.config.ts tsconfig.json tsconfig.node.json ./
COPY components.json ./
COPY .storybook ./.storybook

# Build args — baked into the static bundle at build time
ARG VITE_THUNDERBOLT_CLOUD_URL="/v1"
ARG VITE_AUTH_MODE="oidc"
ENV VITE_THUNDERBOLT_CLOUD_URL=$VITE_THUNDERBOLT_CLOUD_URL
ENV VITE_AUTH_MODE=$VITE_AUTH_MODE

RUN bunx vite build

# Stage 2: Serve with nginx
FROM nginx:alpine

COPY deploy/config/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
