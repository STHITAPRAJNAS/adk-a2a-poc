# Making it EKS-shaped

A local cluster teaches you nothing if its conventions are invented. So this lab
deliberately adopts EKS's labels, its node-group model and its component
boundaries, and names the places where the local stand-in differs. The goal is
that a manifest you write here applies unchanged to EKS, and where it cannot,
you know why before you find out in production.

> **Mac variant:** this lab has **no GPU node group** — a MacBook's GPU is not a
> CUDA device kind can inject. The GPU rows below are kept because they are real
> EKS parity concepts and the node-group *pattern* (labels + taints) is exactly
> what lab 30 teaches here on CPU nodes. To actually schedule onto a GPU node,
> use the Windows lab (`../../k8s-lab/`) or a cloud cluster.

## The parity table

| Concern | EKS | Here | Same? |
|---|---|---|---|
| Control plane | AWS-managed, multi-AZ | kind control-plane container | ✗ single, disposable |
| Node group | `aws_eks_node_group` | kind workers + labels/taints | ✓ same API surface to pods |
| Node labels | `eks.amazonaws.com/nodegroup`, `node.kubernetes.io/instance-type` | **identical keys** | ✓ |
| Availability zones | `topology.kubernetes.io/zone=eu-west-1a` | **same key**, fake values | ✓ for scheduling |
| GPU resource | `nvidia.com/gpu` via device plugin | `nvidia.com/gpu` via device plugin | ✓ genuinely the same |
| GPU taint | `nvidia.com/gpu=present:NoSchedule` from the node group | same taint, applied by you | ✓ |
| Autoscaling | Cluster Autoscaler / Karpenter | none — fixed nodes | ✗ see below |
| Ingress | AWS Load Balancer Controller → ALB/NLB | Envoy Gateway → NodePort | ~ same Gateway API |
| Service mesh | Istio, or App Mesh | Istio ambient | ✓ identical |
| Pod identity | IRSA / EKS Pod Identity | projected SA token | ~ mechanism differs, shape matches |
| Storage | EBS CSI, `gp3` StorageClass | local-path | ✗ no real PV semantics |
| DNS | CoreDNS | CoreDNS | ✓ |
| Registry | ECR with IAM auth | local registry, no auth | ✗ |
| Secrets | Secrets Manager / SSM via CSI | plain Secrets | ✗ |
| Logs | CloudWatch via Fluent Bit | `kubectl logs` | ✗ |

Read the ✗ rows as "this is where the lab stops teaching you EKS". Three of them
matter enough to say more about.

## Autoscaling: the biggest gap

Nodes here are fixed. On EKS the interesting behaviour is what happens when they
are not:

- a GPU pod goes Pending, and **Karpenter provisions a GPU node within a minute**
- the pod finishes, the node is empty for the consolidation window, and the node
  **goes away**
- a `min_size: 0` GPU node group means you pay nothing when idle — by far the
  biggest cost lever on a real GPU cluster

You cannot experience that locally, and it changes how you write manifests: on a
fixed cluster a Pending pod is a bug, on an autoscaled one it is the normal first
second of a pod's life. Lab 30 makes you sit with Pending pods partly so this
distinction lands.

Lab 90 is where you rent a real cluster and watch it.

## Pod identity: the shape without the substance

IRSA gives a pod an AWS identity by projecting a signed ServiceAccount token that
STS will trade for credentials. Locally there is no STS, but the mechanism —
ServiceAccount → projected token → external system trusts your OIDC issuer — is
worth wiring up because **Istio does the same thing for mesh identity**.

That is the connection worth making: `cluster.local/ns/agents/sa/ops-concierge`
in lab 40's `AuthorizationPolicy` and
`arn:aws:iam::…:role/ops-concierge` in an IRSA trust policy are the same idea. One
ServiceAccount, two identity systems, both keyed off it. Design your
ServiceAccounts as identities from the start and both come out right.

## Ingress: why Gateway API and not Ingress

The AWS Load Balancer Controller reads `Ingress` objects (and now Gateway API)
and provisions an ALB. Envoy Gateway reads Gateway API and provisions Envoy pods.
Different implementations, same resources — which is exactly the point of Gateway
API and the reason this lab uses it rather than `Ingress`.

The difference that will bite you: on EKS the data plane is **outside** the
cluster (an ALB), so your mesh's mTLS starts at the pod, and the load balancer
is a separate trust boundary with its own logs, timeouts and WAF. Here the data
plane is a pod, so it can join the mesh (lab 50 does exactly that). When you move
to EKS, revisit every timeout — the ALB has its own idle timeout, defaulting to
60 seconds, which will cut A2A streams that worked locally.

## Naming things the EKS way

Lab 10 labels nodes with EKS's own keys, so manifests port cleanly:

```yaml
nodeSelector:
  eks.amazonaws.com/nodegroup: gpu-a10g        # the node group's name
  node.kubernetes.io/instance-type: g5.xlarge  # what it pretends to be
topology.kubernetes.io/zone: eu-west-1a        # a fake AZ, real key
```

The instance types and zones are fictional. The **keys** are not, and every
`nodeSelector`, `nodeAffinity` and `topologySpreadConstraint` you write against
them works on EKS unchanged. Faking three AZs across four nodes also makes
`topologySpreadConstraints` mean something locally, which they otherwise would
not on a single-zone cluster.

## What to do differently when you get to EKS

1. **Re-check every timeout.** ALB idle timeout, target group timeout, Envoy
   route timeout, Istio destination rule. A2A streams are long; something in that
   chain defaults to 60s.
2. **Put the GPU node group at `min_size: 0`** and let the autoscaler own it.
3. **Move the A2A task store off memory.** Two replicas behind an ALB means a
   resume lands anywhere — the failure lab 20 warns about becomes constant.
4. **Registry auth is real.** ECR pull secrets, or an instance role.
5. **Node groups are immutable.** Changing an AMI or instance type replaces
   nodes. Same lesson kind teaches when you change worker counts.
