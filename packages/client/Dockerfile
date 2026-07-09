FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
RUN npm ci
EXPOSE 7100
CMD ["npx", "tsx", "packages/client/src/index.ts"]
