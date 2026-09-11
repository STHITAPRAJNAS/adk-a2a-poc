output "cluster_name" {
  description = "Feed to `kubectl config use-context kind-<name>`."
  value       = kind_cluster.lab.name
}

output "kubeconfig_path" {
  description = "Later labs export KUBECONFIG to this."
  value       = kind_cluster.lab.kubeconfig_path
}

output "kube_context" {
  description = "kind always prefixes the context with `kind-`."
  value       = "kind-${kind_cluster.lab.name}"
}

output "endpoint" {
  description = "API server address, for anything that needs it directly."
  value       = kind_cluster.lab.endpoint
}

output "expected_node_names" {
  description = <<-EOT
    kind names node containers deterministically, which lab 30 relies on when it
    labels them. If you change the worker counts, this output changes with them.
  EOT
  value = concat(
    ["${kind_cluster.lab.name}-control-plane"],
    [for i in range(var.cpu_worker_count + var.gpu_worker_count) :
      i == 0 ? "${kind_cluster.lab.name}-worker" : "${kind_cluster.lab.name}-worker${i + 1}"
    ],
  )
}

output "cpu_worker_names" {
  description = "The first N workers become the general-purpose pool."
  value = [for i in range(var.cpu_worker_count) :
    i == 0 ? "${kind_cluster.lab.name}-worker" : "${kind_cluster.lab.name}-worker${i + 1}"
  ]
}

output "gpu_worker_names" {
  description = "The remainder become the accelerator pool."
  value = [for i in range(var.cpu_worker_count, var.cpu_worker_count + var.gpu_worker_count) :
    i == 0 ? "${kind_cluster.lab.name}-worker" : "${kind_cluster.lab.name}-worker${i + 1}"
  ]
}
