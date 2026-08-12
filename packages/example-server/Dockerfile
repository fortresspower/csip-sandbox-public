FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
RUN npm ci
RUN npm run build
RUN npm pkg set exports=./dist/index.js --workspace=@fortress-csip/protocol

FROM builder AS production-dependencies
RUN npm prune --omit=dev

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=builder /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=builder /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=builder /app/packages/example-server/package.json ./packages/example-server/package.json
COPY --from=builder /app/packages/example-server/dist ./packages/example-server/dist
COPY --from=builder /app/packages/example-server/public ./packages/example-server/public
USER node
EXPOSE 7001
CMD ["node", "packages/example-server/dist/index.js"]
