FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=neon
ENV NEON_CLOUD_MODE=true

COPY backend/package*.json ./

RUN npm install --omit=dev --ignore-scripts

COPY backend/ ./

EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then((r)=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]