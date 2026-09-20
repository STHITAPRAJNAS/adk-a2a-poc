# Convenience only. Every target prints the command it runs, so you can stop
# using this the moment it gets in your way.
SHELL := /bin/bash
KUBECONFIG_PATH := $(CURDIR)/labs/10-cluster/kubeconfig
export KUBECONFIG = $(KUBECONFIG_PATH)

include versions.env
export

.PHONY: help doctor versions runbook cluster cluster-down image agents place istio gateway a2a-gw \
        verify compare registry-up registry-down clean

runbook:  ## The step-by-step, start to finish
	@less RUNBOOK.md 2>/dev/null || cat RUNBOOK.md

help:  ## List targets
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

doctor:  ## Check this Mac can run the labs (Docker Desktop + kernel limits)
	./scripts/doctor.sh

versions:  ## Show pinned versions and what is current upstream
	@echo "pinned (versions.env):"
	@sed 's/^/  /' versions.env | grep -v '^\s*#' | grep .
	@echo
	@echo "current upstream — check these by hand:"
	@echo "  kind node image  https://github.com/kubernetes-sigs/kind/releases"
	@echo "  istio            https://istio.io/latest/news/releases/"
	@echo "  envoy gateway    https://gateway.envoyproxy.io/news/releases/"
	@echo "  agent router     https://aigateway.envoyproxy.io/release-notes/"
	@echo "  agentgateway     https://github.com/agentgateway/agentgateway/releases"

cluster:  ## Lab 10 — create the kind cluster
	cd labs/10-cluster && terraform init -input=false && terraform apply -auto-approve

cluster-down:  ## Destroy the cluster
	cd labs/10-cluster && terraform destroy -auto-approve

image:  ## Lab 20 — build the agent image and load it into kind
	./images/build.sh

agents:  ## Lab 20 — install both agents
	helm upgrade --install deployment-agent ./charts/adk-agent -n agents --create-namespace \
	  -f ./charts/adk-agent/values-specialist.yaml --wait
	helm upgrade --install ops-concierge ./charts/adk-agent -n agents \
	  -f ./charts/adk-agent/values-concierge.yaml --wait

place:  ## Lab 30 — pin the agents to the general node group and spread by zone
	helm upgrade ops-concierge ./charts/adk-agent -n agents \
	  -f ./charts/adk-agent/values-concierge.yaml -f labs/30-node-groups/agent-placement.yaml
	helm upgrade deployment-agent ./charts/adk-agent -n agents \
	  -f ./charts/adk-agent/values-specialist.yaml -f labs/30-node-groups/agent-placement.yaml

istio:  ## Lab 40 — install Istio ambient and enrol the agents namespace
	./labs/40-istio-ambient/install.sh
	kubectl apply -f ./labs/40-istio-ambient/enroll.yaml

gateway:  ## Lab 50 — Envoy Gateway, north-south HTTP
	./labs/50-north-south/install.sh
	kubectl apply -f ./labs/50-north-south/gateway.yaml -f ./labs/50-north-south/httproute.yaml

verify:  ## Run every verification script that applies
	@for s in scripts/verify-*.sh; do echo "── $$s"; $$s || true; echo; done

compare:  ## The point of the whole lab: east-west vs north-south, side by side
	./scripts/compare-paths.sh

registry-up:  ## Local registry on :5001 for faster image rebuilds
	docker run -d --restart=always -p $(LOCAL_REGISTRY_PORT):5000 --name kind-registry registry:2 || true

registry-down:
	docker rm -f kind-registry || true

clean: cluster-down registry-down  ## Tear everything down
	@echo "gone. `make cluster` rebuilds in about two minutes."
