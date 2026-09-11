# ---------------------------------------------------------------------------
# The cluster itself, and nothing else.
#
# This root module deliberately contains no kubernetes or helm provider. That is
# not tidiness — it is the only arrangement that works.
#
# Terraform must be able to configure a provider at *plan* time, before anything
# has been created. A kubernetes provider configured from this cluster's outputs
# would depend on a resource that does not exist yet, and Terraform will either
# refuse to plan or produce a plan it cannot apply. Real platform teams hit this
# immediately and land on the same answer: one root module owns the cluster's
# lifecycle, separate root modules own what runs inside it.
#
# So: this lab creates the cluster. Lab 30 onwards configure it, reading the
# kubeconfig this one writes.
# ---------------------------------------------------------------------------

provider "kind" {}

resource "kind_cluster" "lab" {
  name           = var.cluster_name
  node_image     = var.node_image
  wait_for_ready = true

  # Written next to this module so later labs can find it without depending on
  # whatever your ~/.kube/config happens to contain.
  kubeconfig_path = abspath("${path.module}/kubeconfig")

  kind_config {
    kind        = "Cluster"
    api_version = "kind.x-k8s.io/v1alpha4"

    # -- control plane ------------------------------------------------------
    # extra_port_mappings punch host ports through to the node container, so a
    # gateway published as a NodePort is reachable from macOS. Without these,
    # labs 50 and 60 would only work through `kubectl port-forward`, and you
    # would never see a real north-south path.
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
    }

    # -- general-purpose pool ----------------------------------------------
    dynamic "node" {
      for_each = range(var.cpu_worker_count)
      content {
        role = "worker"
      }
    }

    # -- accelerator pool ---------------------------------------------------
    # Identical to the above, because on this hardware it genuinely is. The
    # labels and taints that make it "the GPU pool" are applied in lab 30 —
    # against the Kubernetes API, where they belong, and where you can watch the
    # scheduler react to them changing.
    dynamic "node" {
      for_each = range(var.gpu_worker_count)
      content {
        role = "worker"
      }
    }
  }
}
