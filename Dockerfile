FROM node:20

WORKDIR /app

# 의존성 파일 복사
COPY package*.json ./

# 의존성 설치
RUN npm ci --only=production && npm cache clean --force

# 애플리케이션 코드 복사
COPY . .

# 사용자 생성 (Debian 기준)
RUN groupadd -g 1001 nodejs && \
    useradd -m -u 1001 -g nodejs nodejs

# 권한 설정 및 사용자 변경
RUN chown -R nodejs:nodejs /app
USER nodejs

# 포트 노출
EXPOSE 3000

# 헬스체크
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node healthcheck.js || exit 1

# 애플리케이션 시작
CMD ["node", "server.js"]
