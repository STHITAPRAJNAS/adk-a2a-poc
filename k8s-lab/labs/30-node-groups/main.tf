# ---------------------------------------------------------------------------
# Turning four identical workers into two node groups.
#
# On a cloud provider this is a node-group API call and the labels and taints
# arrive with the machines. Locally we do it against the Kubernetes API, which
# is strictly better for learning: you can watch the scheduler react to a label
# appearing, and you can take it away again.
# ---------------------------------------------------------------------------

# --- general-purpose pool --------------------------------------------------
resource "kubernetes_labels" "cpu_pool" {
  for_each = toset(var.cpu_node_names)

  api_version = "v1"
  kind        = "Node"
  metadata { name = each.value }

  labels = {
    # Mirrors the well-known cloud labels, so manifests written here work
    # unchanged against EKS or GKE (lab 90).
    "node.kubernetes.io/instance-type" = "lab.cpu"
    "lab.local/pool"                   = "cpu"
    "lab.local/accelerator"            = "none"
  }
}

# --- accelerator pool ------------------------------------------------------
resource "kubernetes_labels" "gpu_pool" {
  for_each = toset(var.gpu_node_names)

  api_version = "v1"
  kind        = "Node"
  metadata { name = each.value }

  labels = {
    "node.kubernetes.io/instance-type" = "lab.gpu"
    "lab.local/pool"                   = "gpu"
    "lab.local/accelerator"            = "simulated"
  }
}

# A taint is the half people forget. A label lets a pod *choose* the pool; only
# a taint stops everything else drifting onto it. Without this, your general
# workloads spread happily across the expensive nodes and the first GPU job you
# submit sits Pending behind them.
#
# NoSchedule, not NoExecute: NoExecute would evict anything already running
# there, which is a bigger hammer than a fresh pool needs.
resource "kubernetes_node_taint" "gpu_pool" {
  for_each = toset(var.gpu_node_names)

  metadata { name = each.value }
  taint {
    key    = "lab.local/accelerator"
    value  = "simulated"
    effect = "NoSchedule"
  }

  # The taint is meaningless until the label exists to select against.
  depends_on = [kubernetes_labels.gpu_pool]
}
