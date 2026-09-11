# Lab 10 — The cluster

Terraform stands up a four-node kind cluster: one control plane, two workers
that will become the general-purpose pool, one that will become the accelerator
pool.

## Run it

```bash
cd labs/10-cluster
terraform init
terraform plan      # read this properly — it is the whole cluster in one screen
terraform apply

export KUBECONFIG=$PWD/kubeconfig
kubectl get nodes -o wide
```

Expect four nodes `Ready` in a minute or two. First run also pulls the node
image, which is ~1 GB.

## What to notice

**There is no kubernetes provider in this module, and that is deliberate.**
Terraform configures providers at *plan* time, before anything exists. A
kubernetes provider configured from this cluster's own outputs would depend on a
resource that has not been created yet — Terraform will either refuse to plan or
hand you a plan it cannot apply. The fix is structural, not clever: one root
module owns the cluster's lifecycle, separate root modules own its contents.
Lab 30 onwards are those separate modules. Every platform team rediscovers this
in week one.

**`kind_cluster` cannot be modified in place.** The provider supports create and
destroy only. Change `cpu_worker_count` and `terraform plan` shows you a
replacement — the whole cluster, torn down and rebuilt. That is a fair model of
an immutable node group, and a useful habit: node pool shape is a
create/destroy decision, not an edit.

**The port mappings are what make lab 50 real.** Container ports 30080/30443 are
punched through to host 8080/8443, so a gateway published on those NodePorts is
reachable from macOS at `http://localhost:8080`. Without them you would only
ever reach the cluster through `kubectl port-forward`, which tunnels straight
past every gateway you are trying to learn — you would be testing nothing.

**The two pools are identical right now.** Nothing distinguishes a "GPU" worker
at this point; they are the same container image with the same resources. Labels
and taints arrive in lab 30, applied through the Kubernetes API where you can
watch the scheduler react to them. Baking them into the kind config would work
too, but you would never see the before-and-after.

## Verify

```bash
../../scripts/verify-10-cluster.sh
```

Or by hand:

```bash
kubectl get nodes
kubectl get pods -A                    # coredns, kindnet, kube-proxy, local-path
terraform output expected_node_names   # names lab 30 will label
```

## Things that go wrong

| Symptom | Cause |
|---|---|
| `ERROR: failed to create cluster: node(s) already exist` | A cluster of this name exists. `kind delete cluster --name a2a-lab`, or `terraform import`. |
| Nodes stuck `NotReady` | CNI still starting; give it 60s. Still stuck → the VM is out of memory. Raise it. |
| `Cannot connect to the Docker daemon` | Runtime not started. `colima start`, or open Docker Desktop. |
| Apply hangs on `wait_for_ready` | Usually memory. Four nodes need ~6 GB; the default Docker Desktop 2 GB will not do it. |
| Host port 8080 already bound | Something else owns it. Change `http_node_port` and re-apply (which replaces the cluster). |

## Tear down

```bash
terraform destroy
```

Cheap to recreate — around two minutes once the image is cached. Do it whenever
a lab leaves the cluster in a state you cannot explain. Rebuilding is almost
always faster than forensics, and this is exactly the disposability you want
from a learning cluster.

→ [Lab 20: agents on Kubernetes](../20-agents-on-k8s/)
