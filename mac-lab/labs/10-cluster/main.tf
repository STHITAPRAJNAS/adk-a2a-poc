# ---------------------------------------------------------------------------
# A four-node cluster shaped like an EKS cluster with two managed node groups.
#
# No kubernetes or helm provider here, on purpose: Terraform configures
# providers at plan time, and a provider configured from this cluster's outputs
# would depend on something that does not exist yet. One root module owns the
# cluster's lifecycle; later labs own its contents. Real platform teams land on
# the same split within a week.
# ---------------------------------------------------------------------------

provider "kind" {}

locals {
  # Labels every node carries, matching EKS's own keys so that nodeSelectors
  # written against them port unchanged.
  cpu_labels = {
    "eks.amazonaws.com/nodegroup"      = "general"
    "eks.amazonaws.com/capacityType"   = "ON_DEMAND"
    "node.kubernetes.io/instance-type" = var.cpu_instance_type
    "lab.local/pool"                   = "cpu"
  }

  gpu_labels = {
    "eks.amazonaws.com/nodegroup"      = "gpu-a10g"
    "eks.amazonaws.com/capacityType"   = "ON_DEMAND"
    "node.kubernetes.io/instance-type" = var.gpu_instance_type
    "lab.local/pool"                   = "gpu"
    # gpu-feature-discovery sets keys like this on a real cluster. Hardcoded
    # here so manifests can select on accelerator type the way they would in
    # production.
    "nvidia.com/gpu.present"           = "true"
  }
}

resource "kind_cluster" "lab" {
  name            = var.cluster_name
  node_image      = var.node_image
  wait_for_ready  = true
  kubeconfig_path = abspath("${path.module}/kubeconfig")

  kind_config {
    kind        = "Cluster"
    api_version = "kind.x-k8s.io/v1alpha4"

    # --- control plane ---------------------------------------------------
    # Host ports punched through so gateways are reachable from macOS at
    # localhost:8080/8081. Docker Desktop forwards a kind extraPortMapping to
    # the Mac host exactly as WSL2 does on Windows. Without these you would only
    # reach the cluster via `kubectl port-forward`, which tunnels past every
    # proxy the lab is about.
    node {
      role = "control-plane"

      extra_port_mappings {
        container_port = 30080
        host_port      = var.http_node_port
        protocol       = "TCP"
      }
      extra_port_mappings {
        container_port = 30443
        host_port      = var.https_node_port
        protocol       = "TCP"
      }
      extra_port_mappings {
        container_port = 30081
        host_port      = var.agentgateway_node_port
        protocol       = "TCP"
      }
    }

    # --- node group: general ---------------------------------------------
    # Labels and a zone go on at creation, the way a managed node group's
    # launch template would apply them — so a node never exists untagged, even
    # for the few seconds a reconciling controller would take.
    dynamic "node" {
      for_each = range(var.cpu_worker_count)
      content {
        role = "worker"

        kubeadm_config_patches = [
          yamlencode({
            kind = "JoinConfiguration"
            nodeRegistration = {
              kubeletExtraArgs = {
                "node-labels" = join(",", concat(
                  [for k, v in local.cpu_labels : "${k}=${v}"],
                  ["topology.kubernetes.io/zone=${var.zones[node.value % length(var.zones)]}"],
                ))
              }
            }
          })
        ]
      }
    }

    # --- node group: gpu-a10g --------------------------------------------
    # Mac variant: gpu_worker_count defaults to 0, so range(0) is empty and NO
    # GPU node is created. The block is kept verbatim from the Windows lab so
    # the two clusters share one main.tf; it simply produces nothing here.
    dynamic "node" {
      for_each = range(var.gpu_worker_count)
      content {
        role = "worker"

        kubeadm_config_patches = [
          yamlencode({
            kind = "JoinConfiguration"
            nodeRegistration = {
              kubeletExtraArgs = {
                "node-labels" = join(",", concat(
                  [for k, v in local.gpu_labels : "${k}=${v}"],
                  ["topology.kubernetes.io/zone=${var.zones[0]}"],
                ))
                # The taint arrives with the node, exactly as an EKS node group
                # applies it. A node that boots untainted accepts pods it should
                # not for however long a controller takes to notice.
                "register-with-taints" = "nvidia.com/gpu=present:NoSchedule"
              }
            }
          })
        ]

        # ── the GPU injection ───────────────────────────────────────────
        # This is the whole trick. With
        # accept-nvidia-visible-devices-as-volume-mounts=true, the NVIDIA
        # runtime treats a mount under /var/run/nvidia-container-devices/ as a
        # request for that device. kind cannot pass `--gpus`, but it can pass a
        # mount — so the GPU lands in *this node container only*, which is what
        # makes this a genuine node group rather than a cluster-wide flag.
        dynamic "extra_mounts" {
          for_each = var.enable_gpu ? [1] : []
          content {
            host_path      = "/dev/null"
            container_path = "/var/run/nvidia-container-devices/all"
          }
        }
      }
    }
  }
}
