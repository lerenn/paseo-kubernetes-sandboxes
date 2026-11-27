FROM node:22-bookworm-slim
WORKDIR /controller
COPY controller/package.json controller/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY controller/policy.mjs controller/server.mjs controller/gateway.mjs controller/exec.mjs controller/kubernetes.mjs controller/pod.mjs controller/tls.mjs ./
USER node
ENTRYPOINT ["node", "server.mjs"]
