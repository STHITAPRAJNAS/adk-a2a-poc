# Lab 90 — Real GPUs (optional, costs money)

Everything up to here ran free on your Mac. This lab rents actual NVIDIA
hardware so you can see the difference between `lab.local/gpu` and
`nvidia.com/gpu` — which, as it turns out, is almost nothing.

> **This costs money.** A single `g5.xlarge` is roughly $1/hour on demand, plus
> the EKS control plane at ~$0.10/hour. Budget an hour, set a billing alarm, and
> `terraform destroy` when you stop. GPU instances are the classic way to leave
> a lab running over a weekend and regret it.

## Do this lab only when

You have finished lab 30 and want to confirm that what you learned transfers. If
you are short of time or money, skip it — lab 30 taught the operational part and
this mostly confirms it.

## What changes, and what does not

| | Lab 30 (kind) | Here (EKS) |
|---|---|---|
| Resource name | `lab.local/gpu` | `nvidia.com/gpu` |
| Who advertises it | A script patching node status | NVIDIA device plugin DaemonSet |
| Survives kubelet restart | No | Yes — the plugin re-reports |
| Who applies label + taint | You, via `kubernetes_labels` | The node group definition |
| Node pool shape | kind config, cluster replaced | `aws_eks_node_group`, nodes replaced |
| `workloads.yaml` | works | **works, after one rename** |

That last row is the payoff. Copy `labs/30-node-groups/workloads.yaml`, change
`lab.local/gpu` to `nvidia.com/gpu`, and the three scheduling outcomes — yes,
no, not yet — reproduce exactly.

## Sketch

This directory intentionally ships a README rather than applyable Terraform.
Writing it yourself is the exercise, and a copy-pasted EKS module that spends
money unsupervised is not something to ship untested.

```hcl
# Two node groups on one cluster — the whole point of the lab.

resource "aws_eks_node_group" "cpu" {
  cluster_name   = aws_eks_cluster.lab.name
  instance_types = ["m6i.large"]
  scaling_config { desired_size = 2, min_size = 1, max_size = 3 }
  labels = { "lab.local/pool" = "cpu" }
}

resource "aws_eks_node_group" "gpu" {
  cluster_name   = aws_eks_cluster.lab.name
  instance_types = ["g5.xlarge"]              # 1× A10G
  ami_type       = "AL2023_x86_64_NVIDIA"     # driver preinstalled
  scaling_config { desired_size = 1, min_size = 0, max_size = 1 }

  labels = { "lab.local/pool" = "gpu" }

  # The taint arrives with the node group, not afterwards. On a cloud provider
  # this is the correct place for it: a node that boots untainted is a node
  # that accepts a pod it should not, for the several seconds before your
  # controller catches up.
  taint {
    key    = "nvidia.com/gpu"
    value  = "present"
    effect = "NO_SCHEDULE"
  }
}
```

Then the device plugin, which is what actually advertises capacity:

```bash
kubectl apply -f https://raw.githubusercontent.com/NVIDIA/k8s-device-plugin/v0.17.0/deployments/static/nvidia-device-plugin.yml
kubectl get nodes -o custom-columns=NAME:.metadata.name,GPU:.status.allocatable.nvidia\\.com/gpu
```

## Worth doing while you are paying for it

- `min_size = 0` on the GPU group, and watch Cluster Autoscaler or Karpenter
  scale it to zero when nothing tolerates the taint. This is the single biggest
  cost lever on a real GPU cluster, and you cannot experience it locally.
- Run something that actually uses the GPU (`nvidia-smi` in a pod) and confirm
  the resource is *exclusive* — a second pod requesting 1 GPU on a 1-GPU node
  stays Pending even though the first is idle. GPUs are not shared by default,
  and that surprises people who are used to CPU.
- Try time-slicing or MIG to share one GPU across pods, and note that the
  scheduler's view changes while the hardware does not.

## Then destroy it

```bash
terraform destroy
```

Check the console afterwards. Orphaned load balancers and EBS volumes outlive
`destroy` more often than they should, and they bill quietly.

← back to [the lab index](../../README.md)
