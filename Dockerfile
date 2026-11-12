# ---------- 构建阶段 ----------
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
# 只装生产依赖；没有 lock 文件时退化为 npm install
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# ---------- 运行阶段 ----------
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=7000

# 非 root 运行，安全基线
RUN addgroup -S stremio && adduser -S stremio -G stremio

# token → 配置的映射文件落盘目录（compose 里挂卷持久化，重启不丢安装链接）
RUN mkdir -p /app/data && chown stremio:stremio /app/data

COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY server.js addon.js manifest.js ./
COPY lib ./lib
COPY public ./public

USER stremio
EXPOSE 7000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:7000/health || exit 1

CMD ["node", "server.js"]
