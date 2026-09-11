variable "kubeconfig_path" {
  type    = string
  default = "../10-cluster/kubeconfig"
}

variable "kube_context" {
  type    = string
  default = "kind-a2a-lab"
}

variable "cpu_node_names" {
  description = "Workers to label as the general-purpose pool. Matches `terraform output cpu_worker_names` in lab 10."
  type        = list(string)
  default     = ["a2a-lab-worker", "a2a-lab-worker2"]
}

variable "gpu_node_names" {
  description = "Workers to label AND taint as the accelerator pool."
  type        = list(string)
  default     = ["a2a-lab-worker3"]
}

variable "simulated_gpus_per_node" {
  description = <<-EOT
    How many units of the fake accelerator resource each GPU node advertises.

    Deliberately named lab.local/gpu, never nvidia.com/gpu. There is no GPU here
    and nothing should be able to mistake one for the other — see
    docs/apple-silicon-reality.md.
  EOT
  type    = number
  default = 2
}
