import { readFileSync } from "node:fs";
import { request } from "node:https";

const serviceAccount = "/var/run/secrets/kubernetes.io/serviceaccount";

export function inCluster() {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? process.env.KUBERNETES_SERVICE_PORT ?? "443";
  if (!host) throw new Error("Kubernetes service address is missing.");
  const authority = host.includes(":") ? `[${host}]` : host;
  const ca = readFileSync(`${serviceAccount}/ca.crt`);
  return {
    authority: `${authority}:${port}`,
    ca,
    token: () => readFileSync(`${serviceAccount}/token`, "utf8").trim(),
  };
}

export class KubernetesError extends Error {
  constructor(method, status) {
    super(`Kubernetes ${method} request failed (HTTP ${status}).`);
    this.status = status;
  }
}

export function kubeClient({ namespace, connection }) {
  const base = `https://${connection.authority}/api/v1/namespaces/${encodeURIComponent(namespace)}`;
  async function call(method, path, body) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(base + path, {
        method,
        ca: connection.ca,
        signal: AbortSignal.timeout(15_000),
        headers: {
          authorization: `Bearer ${connection.token()}`,
          accept: "application/json",
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new KubernetesError(method, res.statusCode));
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch (error) { reject(error); }
        });
      });
      req.on("error", reject);
      req.end(payload);
    });
  }
  const ignoreNotFound = (error) => {
    if (error instanceof KubernetesError && error.status === 404) return null;
    throw error;
  };
  const podPath = (name) => `/pods/${encodeURIComponent(name)}`;
  return {
    getService: (name) => call("GET", `/services/${encodeURIComponent(name)}`),
    getPod: (name) => call("GET", podPath(name)).catch(ignoreNotFound),
    createPod: (pod) => call("POST", "/pods", pod),
    deletePod: (pod) => call("DELETE", podPath(pod.metadata.name), {
      apiVersion: "v1",
      kind: "DeleteOptions",
      preconditions: { uid: pod.metadata.uid },
    }).catch(ignoreNotFound),
    async *listPods(selector) {
      const params = new URLSearchParams({ labelSelector: selector, limit: "100" });
      for (;;) {
        const page = await call("GET", `/pods?${params}`);
        yield* page.items;
        if (!page.metadata.continue) return;
        params.set("continue", page.metadata.continue);
      }
    },
  };
}
