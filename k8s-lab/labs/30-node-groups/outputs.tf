output "cpu_nodes" { value = var.cpu_node_names }
output "gpu_nodes" { value = var.gpu_node_names }

output "extended_resource_patch_hint" {
  description = "Terraform cannot patch node status; scripts/advertise-gpu.sh does it."
  value       = "run ../../scripts/advertise-gpu.sh ${join(" ", var.gpu_node_names)} ${var.simulated_gpus_per_node}"
}
