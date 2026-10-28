FROM node:20-alpine
WORKDIR /app
COPY . .
ENV PORT=8080
ENV DATA_DIR=/data
RUN mkdir -p /data
EXPOSE 8080
CMD ["node", "server.js"]
