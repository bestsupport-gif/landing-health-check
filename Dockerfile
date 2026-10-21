# Playwright 공식 이미지 (Chromium + 시스템 의존성 포함). package.json 의 playwright 버전과 맞춘다.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    TZ=Asia/Seoul \
    DATA_DIR=/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown -R pwuser:pwuser /data /app
USER pwuser

EXPOSE 3000
CMD ["node", "src/server.js"]
