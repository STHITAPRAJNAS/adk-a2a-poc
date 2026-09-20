output "cluster_name" { value = kind_cluster.lab.name }
output "kubeconfig_path" { value = kind_cluster.lab.kubeconfig_path }
output "kube_context" { value = "kind-${kind_cluster.lab.name}" }
output "endpoint" { value = kind_cluster.lab.endpoint }

output "cpu_worker_names" {
  value = [for i in range(var.cpu_worker_count) :
    i == 0 ? "${kind_cluster.lab.name}-worker" : "${kind_cluster.lab.name}-worker${i + 1}"
  ]
}

output "next_steps" {
  value = <<-EOT

    export KUBECONFIG=${kind_cluster.lab.kubeconfig_path}
    kubectl get nodes -L eks.amazonaws.com/nodegroup,topology.kubernetes.io/zone

    Mac variant: no GPU node group. Next: build the agent image (../../images/build.sh)
    and continue with lab 20. Lab 30 teaches scheduling on the CPU node pool.
  EOT
}
