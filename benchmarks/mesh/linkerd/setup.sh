#!/usr/bin/env bash
set -euo pipefail

KIND_VERSION="${KIND_VERSION:-v0.33.0}"
KIND_NODE="${KIND_NODE:-kindest/node:v1.35.0}"
LINKERD_EDGE="${LINKERD_EDGE:-edge-26.6.3}"
GATEWAY_API_VERSION="${GATEWAY_API_VERSION:-v1.5.1}"
CLUSTER_NAME="${CLUSTER_NAME:-openmesh-meshbench}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

cleanup() {
  kind delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1 || true
}

if ! command -v kind >/dev/null 2>&1; then
  curl -fsSL "https://kind.sigs.k8s.io/dl/${KIND_VERSION}/kind-linux-amd64" -o /usr/local/bin/kind
  chmod +x /usr/local/bin/kind
fi

curl -fsSL "https://github.com/linkerd/linkerd2/releases/download/${LINKERD_EDGE}/linkerd2-cli-${LINKERD_EDGE}-linux-amd64" -o /tmp/linkerd
chmod +x /tmp/linkerd

cleanup
kind create cluster --name "$CLUSTER_NAME" --image "$KIND_NODE" --wait 180s

kubectl apply -f "https://github.com/kubernetes-sigs/gateway-api/releases/download/${GATEWAY_API_VERSION}/standard-install.yaml"
kubectl wait --for=condition=Established --timeout=120s crd/httproutes.gateway.networking.k8s.io

/tmp/linkerd check --pre
/tmp/linkerd install --crds | kubectl apply -f -
/tmp/linkerd install | kubectl apply -f -

kubectl rollout status -n linkerd deploy/linkerd-destination --timeout=180s
kubectl rollout status -n linkerd deploy/linkerd-identity --timeout=180s
kubectl rollout status -n linkerd deploy/linkerd-proxy-injector --timeout=180s
/tmp/linkerd check --wait 180s

docker build -t openmesh-meshbench-app:local "$ROOT/benchmarks/mesh/linkerd"
kind load docker-image --name "$CLUSTER_NAME" openmesh-meshbench-app:local

kubectl apply -f "$ROOT/benchmarks/mesh/linkerd/workloads.yaml"
kubectl rollout status -n bench-direct deploy/backend --timeout=120s
kubectl rollout status -n bench-direct deploy/gateway --timeout=120s
kubectl rollout status -n bench-linkerd deploy/backend --timeout=120s
kubectl rollout status -n bench-linkerd deploy/gateway --timeout=120s

# Verify all meshed workloads actually have the proxy before measuring.
for selector in app=bench-backend app=bench-gateway; do
  kubectl get pods -n bench-linkerd -l "$selector" -o json |
    node -e '
      let text="";
      process.stdin.on("data", c => text += c).on("end", () => {
        const pods=JSON.parse(text).items;
        if (!pods.length) throw new Error("No pods for selector");
        for (const pod of pods) {
          const names=pod.spec.containers.map(c => c.name);
          if (!names.includes("linkerd-proxy")) throw new Error(pod.metadata.name + " is not meshed");
        }
      });
    '
done

/tmp/linkerd check --proxy --namespace bench-linkerd --wait 120s

echo "Linkerd benchmark cluster ready"
