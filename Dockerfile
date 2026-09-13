FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/daemon/package.json apps/daemon/package.json
COPY apps/companion/package.json apps/companion/package.json
RUN npm ci
COPY . .
RUN npm run db:generate && npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 4100
CMD ["sh", "-c", "npm run db:migrate && npm run start -w @relaycode/server"]
