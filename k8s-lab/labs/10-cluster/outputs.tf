output "cluster_name" { value = kind_cluster.lab.name }
output "kubeconfig_path" { value = kind_cluster.lab.kubeconfig_path }
output "kube_context" { value = "kind-${kind_cluster.lab.name}" }
output "endpoint" { value = kind_cluster.lab.endpoint }
output "gpu_enabled" { value = var.enable_gpu }

output "cpu_worker_names" {
  value = [for i in range(var.cpu_worker_count) :
    i == 0 ? "${kind_cluster.lab.name}-worker" : "${kind_cluster.lab.name}-worker${i + 1}"
  ]
}

output "gpu_worker_names" {
  value = [for i in range(var.cpu_worker_count, var.cpu_worker_count + var.gpu_worker_count) :
    i == 0 ? "${kind_cluster.lab.name}-worker" : "${kind_cluster.lab.name}-worker${i + 1}"
  ]
}

output "next_steps" {
  value = <<-EOT

    export KUBECONFIG=${kind_cluster.lab.kubeconfig_path}
    kubectl get nodes -L eks.amazonaws.com/nodegroup,topology.kubernetes.io/zone

    ${var.enable_gpu
      ? "GPU injection is ON. Next: ../../scripts/setup-gpu-node.sh  (containerd inside the node still needs the nvidia runtime)"
      : "GPU injection is OFF. Lab 30 will take the simulated path."}
  EOT
}
